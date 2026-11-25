/**
 * Pure orchestration for the optional Forge LLM call.
 *
 * This module deliberately has no Forge imports. `src/llm.js` injects the
 * Forge `chat` function, which lets node:test exercise the truncation retry
 * and fallback paths with a stubbed chat function and no network access.
 *
 * Budgeting: the Forge resolver invocation limit is 25 seconds. The whole
 * model phase is capped by `totalBudgetMs` (22 seconds by default), and each
 * attempt is separately capped by `attemptTimeoutMs` (15 seconds). A first
 * attempt that consumes its full timeout still leaves only the remaining
 * budget for the single retry, so the model phase cannot run for 30 seconds.
 */
import { parseHypothesesDetailed } from './llmParser.js';

export const DEFAULT_ATTEMPT_TIMEOUT_MS = 15000;
export const DEFAULT_TOTAL_BUDGET_MS = 22000;
export const MIN_RETRY_BUDGET_MS = 3000;

// Forge documents `finish_reason` as a string but does not enumerate every
// value. Treat the common truncation spellings defensively; normal completion
// values such as "stop" and "tool_use" are not truncation.
const TRUNCATION_FINISH_REASONS = new Set([
  'length',
  'max_tokens',
  'max_output_tokens',
]);

/**
 * Reads `choices[0].finish_reason` from the documented Forge LLM response.
 *
 * @param {object} response
 * @returns {string|null}
 */
export function finishReasonOf(response) {
  const reason = response?.choices?.[0]?.finish_reason;
  return typeof reason === 'string' && reason.trim().length > 0
    ? reason.trim()
    : null;
}

/**
 * Returns true when the response stopped because it hit the output limit.
 *
 * @param {object} response
 * @returns {boolean}
 */
export function isTruncationFinish(response) {
  const reason = finishReasonOf(response);
  return reason !== null && TRUNCATION_FINISH_REASONS.has(reason.toLowerCase());
}

/**
 * Reads the documented usage object when the provider returns one.
 *
 * @param {object} response
 * @returns {object|null}
 */
export function usageOf(response) {
  const usage = response?.usage;
  return usage && typeof usage === 'object' && !Array.isArray(usage)
    ? usage
    : null;
}

function contentOf(response) {
  return response?.choices?.[0]?.message?.content;
}

function outcomeFor(response, parseOptions) {
  const finishReason = finishReasonOf(response);
  const usage = usageOf(response);
  const content = contentOf(response);

  if (content === undefined || content === null || content === '') {
    return {
      finish_reason: finishReason,
      usage,
      hypotheses: [],
      salvage_used: false,
      parse_error: new Error('Forge LLM returned no message content.'),
    };
  }

  try {
    const parsed = parseHypothesesDetailed(content, parseOptions);
    return {
      finish_reason: finishReason,
      usage,
      hypotheses: parsed.hypotheses,
      salvage_used: parsed.salvage_used,
      parse_error: null,
    };
  } catch (error) {
    return {
      finish_reason: finishReason,
      usage,
      hypotheses: [],
      salvage_used: false,
      parse_error: error,
    };
  }
}

async function callWithTimeout(chatFn, request, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      'Forge LLM call skipped: the resolver budget was already exhausted.',
    );
  }

  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Forge LLM call timed out after ${Math.round(timeoutMs)} ms.`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([chatFn(request), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function describeOutcome(outcome) {
  const parts = [];

  if (outcome.finish_reason) {
    parts.push(`finish_reason: ${outcome.finish_reason}`);
  }
  if (outcome.salvage_used) {
    parts.push('partial JSON was salvaged');
  }
  if (outcome.parse_error) {
    parts.push(
      outcome.parse_error instanceof Error
        ? outcome.parse_error.message
        : String(outcome.parse_error),
    );
  }

  return parts.length > 0 ? parts.join('; ') : 'no usable output';
}

/**
 * Calls the model once and retries once when the first response was truncated.
 *
 * Retry rules:
 * - Only a truncation finish reason triggers the retry. Transport errors and
 *   ordinary malformed JSON propagate so the caller can fall back.
 * - Any complete hypothesis objects salvaged from the first response are kept
 *   if the retry also fails, as long as their citations are complete.
 * - The retry runs only when at least `MIN_RETRY_BUDGET_MS` remains.
 *
 * @param {object} params
 * @param {(request: object) => Promise<object>} params.chatFn
 * @param {object} params.firstRequest
 * @param {object} params.retryRequest
 * @param {object} params.parseOptions - allowedFactIds and blockedFactIds.
 * @param {number} [params.attemptTimeoutMs]
 * @param {number} [params.totalBudgetMs]
 * @param {() => number} [params.now]
 * @returns {Promise<object>}
 */
export async function runChatWithRetry({
  chatFn,
  firstRequest,
  retryRequest,
  parseOptions,
  attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
  totalBudgetMs = DEFAULT_TOTAL_BUDGET_MS,
  now = Date.now,
}) {
  if (typeof chatFn !== 'function') {
    throw new TypeError('runChatWithRetry expects a chat function.');
  }

  const deadline = now() + totalBudgetMs;
  const remaining = () => deadline - now();

  const firstResponse = await callWithTimeout(
    chatFn,
    firstRequest,
    Math.min(attemptTimeoutMs, remaining()),
  );
  const firstOutcome = outcomeFor(firstResponse, parseOptions);

  if (!isTruncationFinish(firstResponse)) {
    if (firstOutcome.hypotheses.length > 0) {
      return { ...firstOutcome, retry_used: false };
    }

    throw (
      firstOutcome.parse_error ||
      new Error('Forge LLM returned no usable hypotheses.')
    );
  }

  if (remaining() < MIN_RETRY_BUDGET_MS) {
    if (firstOutcome.hypotheses.length > 0) {
      return { ...firstOutcome, retry_used: false, retry_skipped: true };
    }

    throw new Error(
      `Forge LLM response was truncated (${describeOutcome(
        firstOutcome,
      )}) and the retry budget was exhausted.`,
    );
  }

  let retryOutcome = null;
  try {
    const retryResponse = await callWithTimeout(
      chatFn,
      retryRequest,
      Math.min(attemptTimeoutMs, remaining()),
    );
    retryOutcome = outcomeFor(retryResponse, parseOptions);

    if (retryOutcome.hypotheses.length > 0) {
      return { ...retryOutcome, retry_used: true };
    }
  } catch (error) {
    retryOutcome = {
      finish_reason: null,
      usage: null,
      hypotheses: [],
      salvage_used: false,
      parse_error: error,
    };
  }

  if (firstOutcome.hypotheses.length > 0) {
    return { ...firstOutcome, retry_used: true, retry_failed: true };
  }

  throw new Error(
    `Forge LLM response was truncated and could not be salvaged (${describeOutcome(
      firstOutcome,
    )}; retry: ${describeOutcome(retryOutcome)}).`,
  );
}

/**
 * Runs the model and converts any failure into the caller's fallback result.
 *
 * The fallback callback is supplied by `src/llm.js` so this module stays pure
 * and testable. The returned diagnostics include the finish reason and output
 * token count, which makes truncation visible in logs without exposing secrets.
 *
 * @param {object} params
 * @param {(request: object) => Promise<object>} params.chatFn
 * @param {object} params.firstRequest
 * @param {object} params.retryRequest
 * @param {object} params.parseOptions
 * @param {(error: Error) => object} params.fallback
 * @param {number} [params.attemptTimeoutMs]
 * @param {number} [params.totalBudgetMs]
 * @param {() => number} [params.now]
 * @returns {Promise<object>}
 */
export async function generateHypothesesWithChat({
  chatFn,
  firstRequest,
  retryRequest,
  parseOptions,
  fallback,
  attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
  totalBudgetMs = DEFAULT_TOTAL_BUDGET_MS,
  now = Date.now,
}) {
  try {
    const outcome = await runChatWithRetry({
      chatFn,
      firstRequest,
      retryRequest,
      parseOptions,
      attemptTimeoutMs,
      totalBudgetMs,
      now,
    });

    return {
      hypotheses: outcome.hypotheses,
      source: 'llm',
      model: firstRequest?.model ?? 'unknown',
      fallback_used: false,
      diagnostics: {
        finish_reason: outcome.finish_reason,
        output_tokens:
          typeof outcome.usage?.output_tokens === 'number'
            ? outcome.usage.output_tokens
            : null,
        retry_used: Boolean(outcome.retry_used),
        retry_failed: Boolean(outcome.retry_failed),
        retry_skipped: Boolean(outcome.retry_skipped),
        salvage_used: Boolean(outcome.salvage_used),
      },
    };
  } catch (error) {
    if (typeof fallback !== 'function') {
      throw error;
    }
    return fallback(error);
  }
}
