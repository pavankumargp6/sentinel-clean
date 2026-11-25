/**
 * Pure parsing and prompt-shaping helpers for the optional Forge LLM path.
 *
 * This module deliberately has no Forge imports so it can be loaded by
 * `node:test` without a Forge runtime. `src/llm.js` is the only module that
 * imports `@forge/llm` or calls the model.
 *
 * @typedef {import('./ledger.js').Fact} Fact
 */

// The prompt asks for three hypotheses with at most four citations each. The
// parser enforces the same caps so a model that ignores the instruction cannot
// inflate the stored run or the scored output.
export const MAX_HYPOTHESES = 3;
export const MAX_CITATIONS_PER_HYPOTHESIS = 4;

export class HypothesisParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HypothesisParseError';
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Converts a Forge LLM message `content` value to plain text.
 *
 * `@forge/llm` returns either a string or an array of `{ type: 'text', text }`
 * content parts. Unknown parts are ignored rather than echoed into the parser.
 *
 * @param {unknown} content
 * @returns {string}
 */
export function contentToText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (isPlainObject(part) && part.type === 'text' && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .join('');
}

/**
 * Removes a Markdown code fence when the model wraps its JSON in one.
 * Prose outside the fence is discarded as well.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripCodeFences(text) {
  if (typeof text !== 'string') {
    return '';
  }

  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Builds the only fact shape that is allowed across the model boundary.
 * Source refs, service scopes, environments, and clusters stay local.
 *
 * @param {Fact[]} facts
 * @returns {{
 *   fact_id: string,
 *   fact_type: string,
 *   summary: string,
 *   observed_at: string,
 *   weight: number,
 * }[]}
 */
export function toPromptFacts(facts) {
  if (!Array.isArray(facts)) {
    throw new TypeError('toPromptFacts expects an array of facts.');
  }

  return facts.map((fact) => ({
    fact_id: fact.fact_id,
    fact_type: fact.fact_type,
    summary: fact.summary,
    observed_at: fact.observed_at,
    weight: fact.weight,
  }));
}

function readAllowedFactIds(options) {
  const allowedFactIds = options && options.allowedFactIds;
  if (allowedFactIds instanceof Set) {
    return allowedFactIds;
  }
  if (Array.isArray(allowedFactIds)) {
    return new Set(allowedFactIds);
  }
  throw new TypeError(
    'parseHypotheses expects options.allowedFactIds as an array or Set.',
  );
}

function readBlockedFactIds(options) {
  const blockedFactIds = options && options.blockedFactIds;
  if (blockedFactIds === undefined) {
    return new Set();
  }
  if (blockedFactIds instanceof Set) {
    return blockedFactIds;
  }
  if (Array.isArray(blockedFactIds)) {
    return new Set(blockedFactIds);
  }
  throw new TypeError(
    'parseHypotheses expects options.blockedFactIds as an array or Set when provided.',
  );
}

function normalizeHypothesis(item, allowedFactIds, blockedFactIds) {
  if (!isPlainObject(item)) {
    return null;
  }

  const hypothesisId =
    typeof item.hypothesis_id === 'string' ? item.hypothesis_id.trim() : '';
  const summary = typeof item.summary === 'string' ? item.summary.trim() : '';

  if (hypothesisId.length === 0 || summary.length === 0) {
    return null;
  }
  if (!Array.isArray(item.citations)) {
    return null;
  }

  const citations = [];
  const seenCitations = new Set();

  for (const citation of item.citations) {
    if (!isPlainObject(citation)) {
      continue;
    }

    const factId =
      typeof citation.fact_id === 'string' ? citation.fact_id.trim() : '';
    const stance = citation.stance;

    if (factId.length === 0) {
      continue;
    }
    if (stance !== 'supports' && stance !== 'contradicts') {
      continue;
    }
    if (!allowedFactIds.has(factId) || blockedFactIds.has(factId)) {
      continue;
    }

    const citationKey = `${factId}:${stance}`;
    if (seenCitations.has(citationKey)) {
      continue;
    }
    seenCitations.add(citationKey);

    // The model does not get to choose a confidence or a citation's parent.
    // It supplies stance only; the scorer assigns the causal/context role from
    // the cited fact's type. Rebuild the citation with only known fields.
    citations.push({
      hypothesis_id: hypothesisId,
      fact_id: factId,
      stance,
    });

    if (citations.length >= MAX_CITATIONS_PER_HYPOTHESIS) {
      break;
    }
  }

  return {
    hypothesis_id: hypothesisId,
    summary,
    citations,
  };
}

/**
 * Normalizes a list of parsed hypothesis objects and removes duplicates.
 *
 * @param {unknown[]} items
 * @param {Set<string>} allowedFactIds
 * @param {Set<string>} blockedFactIds
 * @returns {object[]}
 */
function collectHypotheses(items, allowedFactIds, blockedFactIds) {
  const hypotheses = [];
  const seenHypothesisIds = new Set();

  for (const item of items) {
    const hypothesis = normalizeHypothesis(
      item,
      allowedFactIds,
      blockedFactIds,
    );

    if (hypothesis === null) {
      continue;
    }
    if (seenHypothesisIds.has(hypothesis.hypothesis_id)) {
      continue;
    }
    seenHypothesisIds.add(hypothesis.hypothesis_id);
    hypotheses.push(hypothesis);

    if (hypotheses.length >= MAX_HYPOTHESES) {
      break;
    }
  }

  return hypotheses;
}

/**
 * Extracts balanced JSON objects from a possibly truncated document.
 *
 * The scanner understands quoted strings and escapes, so braces inside a
 * summary do not confuse it. It returns objects in closing order, which means
 * nested citation objects appear before their parent hypothesis. Callers must
 * still validate each candidate as a complete hypothesis.
 *
 * A truncated object is never returned because it has no closing brace. That
 * is the key safety property: an incomplete citation cannot be accepted on its
 * own, and a truncated hypothesis that contains it is discarded with it.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractBalancedObjects(text) {
  const objects = [];
  const openIndexes = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      openIndexes.push(index);
    } else if (character === '}') {
      const start = openIndexes.pop();
      if (start !== undefined) {
        objects.push(text.slice(start, index + 1));
      }
    }
  }

  return objects;
}

/**
 * Recovers complete hypothesis objects from truncated JSON.
 *
 * @param {string} text
 * @param {Set<string>} allowedFactIds
 * @param {Set<string>} blockedFactIds
 * @returns {object[]}
 */
function salvageHypothesesWithSets(text, allowedFactIds, blockedFactIds) {
  const candidates = extractBalancedObjects(text);
  const hypotheses = [];
  const seenHypothesisIds = new Set();

  for (const candidate of candidates) {
    let item;
    try {
      item = JSON.parse(candidate);
    } catch {
      continue;
    }

    const hypothesis = normalizeHypothesis(
      item,
      allowedFactIds,
      blockedFactIds,
    );
    if (hypothesis === null) {
      continue;
    }
    if (seenHypothesisIds.has(hypothesis.hypothesis_id)) {
      continue;
    }

    seenHypothesisIds.add(hypothesis.hypothesis_id);
    hypotheses.push(hypothesis);

    if (hypotheses.length >= MAX_HYPOTHESES) {
      break;
    }
  }

  return hypotheses;
}

/**
 * Public salvage helper for tests and diagnostics.
 *
 * @param {string} text
 * @param {{
 *   allowedFactIds: string[]|Set<string>,
 *   blockedFactIds?: string[]|Set<string>,
 * }} options
 * @returns {object[]}
 */
export function salvageHypotheses(text, options) {
  const allowedFactIds = readAllowedFactIds(options);
  const blockedFactIds = readBlockedFactIds(options);
  return salvageHypothesesWithSets(
    typeof text === 'string' ? text : '',
    allowedFactIds,
    blockedFactIds,
  );
}

/**
 * Parses model output and reports whether truncated-JSON salvage was used.
 *
 * The parser is deliberately forgiving at item level: malformed hypotheses and
 * citations are dropped so one bad object cannot fail an otherwise usable run.
 * If the document is truncated JSON, complete hypothesis objects are recovered
 * first. A document with no recoverable hypotheses throws so the caller can
 * fall back to the deterministic mock with a visible reason.
 *
 * Citations are accepted only when they point at an allowed fact. The scorer
 * remains the authoritative second guard and blocks remediation citations even
 * if this filter is ever bypassed.
 *
 * @param {unknown} content - Forge LLM `message.content` (string or content parts).
 * @param {{
 *   allowedFactIds: string[]|Set<string>,
 *   blockedFactIds?: string[]|Set<string>,
 * }} options
 * @returns {{hypotheses: object[], salvage_used: boolean}}
 */
export function parseHypothesesDetailed(content, options) {
  const allowedFactIds = readAllowedFactIds(options);
  const blockedFactIds = readBlockedFactIds(options);

  const text = stripCodeFences(contentToText(content));
  if (text.length === 0) {
    throw new HypothesisParseError('Forge LLM returned empty content.');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // A response cut off by the completion-token limit is still useful if one
    // or more hypothesis objects closed before the cut. Never accept a partial
    // object or a citation without its parent hypothesis.
    const salvaged = salvageHypothesesWithSets(
      text,
      allowedFactIds,
      blockedFactIds,
    );
    if (salvaged.length > 0) {
      return { hypotheses: salvaged, salvage_used: true };
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new HypothesisParseError(
      `Forge LLM did not return valid JSON: ${reason}`,
    );
  }

  let items;
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (isPlainObject(parsed) && Array.isArray(parsed.hypotheses)) {
    items = parsed.hypotheses;
  } else {
    throw new HypothesisParseError(
      'Forge LLM JSON must be an array of hypotheses.',
    );
  }

  return {
    hypotheses: collectHypotheses(
      items,
      allowedFactIds,
      blockedFactIds,
    ),
    salvage_used: false,
  };
}

/**
 * Parses model output into scored-hypothesis input.
 *
 * This wrapper keeps the original public API used by tests and callers that do
 * not need the salvage flag.
 *
 * @param {unknown} content
 * @param {{
 *   allowedFactIds: string[]|Set<string>,
 *   blockedFactIds?: string[]|Set<string>,
 * }} options
 * @returns {object[]}
 */
export function parseHypotheses(content, options) {
  return parseHypothesesDetailed(content, options).hypotheses;
}
