/**
 * Pure parsing and prompt-shaping helpers for the optional Forge LLM path.
 *
 * This module deliberately has no Forge imports so it can be loaded by
 * `node:test` without a Forge runtime. `src/llm.js` is the only module that
 * imports `@forge/llm` or calls the model.
 *
 * @typedef {import('./ledger.js').Fact} Fact
 */

export const MAX_HYPOTHESES = 5;
export const MAX_CITATIONS_PER_HYPOTHESIS = 20;

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
    // Rebuild the citation with only the fields the scorer understands.
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
 * Parses model output into scored-hypothesis input.
 *
 * The parser is deliberately forgiving at item level: malformed hypotheses and
 * citations are dropped so one bad object cannot fail an otherwise usable run.
 * A document that is not JSON, or is not an array of hypotheses, throws so the
 * caller can fall back to the deterministic mock with a visible reason.
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
 * @returns {{
 *   hypothesis_id: string,
 *   summary: string,
 *   citations: {
 *     hypothesis_id: string,
 *     fact_id: string,
 *     stance: 'supports'|'contradicts',
 *   }[],
 * }[]}
 */
export function parseHypotheses(content, options) {
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
