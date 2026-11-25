/**
 * Optional Forge LLM hypothesis generator.
 *
 * This is the only Sentinel module that imports `@forge/llm` or calls a model.
 * The deterministic scoring pipeline remains authoritative: model output is
 * parsed into the same hypothesis shape the mock produces, and then scored by
 * `src/scoring.js`.
 *
 * `@forge/llm` requires the Forge runtime, so tests exercise the pure retry and
 * parser modules (`src/llmRun.js` and `src/llmParser.js`) instead of this file.
 */
import { chat } from '@forge/llm';

import { generateMockHypotheses } from './mockLLM.js';
import { toPromptFacts } from './llmParser.js';
import { generateHypothesesWithChat } from './llmRun.js';

// Change the model here. Keep it as a single constant so upgrades are explicit.
export const MODEL_ID = 'claude-sonnet-4-6';

// The previous 800-token cap truncated a three-hypothesis JSON response at
// roughly 2,490 characters. Forge exposes the provider's finish reason, so the
// caller can now detect truncation, retry once, and salvage complete objects.
export const MAX_COMPLETION_TOKENS = 2000;
export const TEMPERATURE = 0;

// Per-attempt timeout. The bridge/resolver invocation limit is 25 seconds, so
// the whole model phase also has a separate total budget below. A first attempt
// that uses all 15 seconds leaves at most 7 seconds for the one retry.
export const LLM_TIMEOUT_MS = 15000;

// Overall model-phase budget, including the retry. Keep this below 25 seconds
// so KVS reads and deterministic scoring still fit in the resolver invocation.
export const LLM_TOTAL_BUDGET_MS = 22000;

const MAX_FALLBACK_REASON_LENGTH = 500;

const SYSTEM_PROMPT = `You are Sentinel, an incident-analysis assistant.
You receive a JSON array of verified incident facts. Return exactly 3 candidate root-cause hypotheses.

Rules:
- Return JSON only. No prose, no markdown, and no code fences.
- Return a JSON array. Each item must have exactly these fields:
  "hypothesis_id" (unique non-empty string),
  "summary" (non-empty string, at most 25 words),
  "citations" (array of at most 4 citation objects).
- Each citation must have exactly "hypothesis_id", "fact_id", and "stance".
- Cite only fact_id values present in the provided facts. Never invent facts or fact IDs.
- "stance" must be exactly "supports" or "contradicts".
- An alert fact (fact_type "alert") describes the symptom to be explained. It is context, not causal evidence; never treat an alert as support for a root cause.
- Alert citations may be included for context, but they contribute no causal weight.
- Use "contradicts" for facts that weaken a hypothesis, for example a deploy to an unrelated service.
- Omit facts that are irrelevant to a hypothesis instead of citing them.
- Do not include a confidence, probability, score, or any other field.
- Every hypothesis must cite at least one non-alert provided fact.`;

const RETRY_SYSTEM_PROMPT = `You are Sentinel, an incident-analysis assistant.
The previous response was truncated. Return a shorter JSON array now.

Rules:
- Return JSON only. No prose, no markdown, and no code fences.
- Return exactly 2 candidate root-cause hypotheses.
- Each item must have exactly these fields:
  "hypothesis_id" (unique non-empty string),
  "summary" (non-empty string, at most 20 words),
  "citations" (array of at most 3 citation objects).
- Each citation must have exactly "hypothesis_id", "fact_id", and "stance".
- Cite only fact_id values present in the provided facts. Never invent facts or fact IDs.
- "stance" must be exactly "supports" or "contradicts".
- An alert fact (fact_type "alert") is context, not causal evidence.
- Use "contradicts" for facts that weaken a hypothesis.
- Omit facts that are irrelevant to a hypothesis instead of citing them.
- Do not include a confidence, probability, score, or any other field.
- Every hypothesis must cite at least one non-alert provided fact.`;

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_FALLBACK_REASON_LENGTH
    ? `${message.slice(0, MAX_FALLBACK_REASON_LENGTH)}...`
    : message;
}

function buildMessages(filteredFacts, { retry = false } = {}) {
  return [
    {
      role: 'system',
      content: retry ? RETRY_SYSTEM_PROMPT : SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: [
        'Incident facts:',
        JSON.stringify(toPromptFacts(filteredFacts), null, 2),
        '',
        retry ? 'Return the shorter JSON array now.' : 'Return the JSON array now.',
      ].join('\n'),
    },
  ];
}

function buildRequest(filteredFacts, retry = false) {
  return {
    model: MODEL_ID,
    messages: buildMessages(filteredFacts, { retry }),
    temperature: TEMPERATURE,
    max_completion_tokens: MAX_COMPLETION_TOKENS,
  };
}

function mockResult(filteredFacts, reason) {
  return {
    hypotheses: generateMockHypotheses(filteredFacts),
    source: 'mock',
    model: 'deterministic-mock',
    fallback_used: true,
    fallback_reason: reason,
  };
}

/**
 * Generates hypotheses with the Forge LLM, falling back to the deterministic
 * mock on timeout, transport error, empty content, unusable JSON, or a
 * truncation that cannot be retried or salvaged.
 *
 * The model phase is capped by `LLM_TOTAL_BUDGET_MS`, not by two full
 * `LLM_TIMEOUT_MS` attempts. That keeps the resolver invocation below its
 * 25-second limit even when the model is slow.
 *
 * @param {import('./ledger.js').Fact[]} filteredFacts - Facts that survived the
 *   Causal Inversion Guard. Only the allowed prompt fields cross the boundary.
 * @param {string[]} [blockedFactIds] - Fact IDs the parser must never accept,
 *   even if they accidentally reach the filtered list (for example,
 *   remediation actions).
 * @returns {Promise<{
 *   hypotheses: {
 *     hypothesis_id: string,
 *     summary: string,
 *     citations: {
 *       hypothesis_id: string,
 *       fact_id: string,
 *       stance: 'supports'|'contradicts',
 *     }[],
 *   }[],
 *   source: 'llm'|'mock',
 *   model: string,
 *   fallback_used: boolean,
 *   fallback_reason?: string,
 *   diagnostics?: {
 *     finish_reason: string|null,
 *     output_tokens: number|null,
 *     retry_used: boolean,
 *     retry_failed: boolean,
 *     retry_skipped: boolean,
 *     salvage_used: boolean,
 *   },
 * }>}
 */
export async function generateHypotheses(
  filteredFacts,
  blockedFactIds = [],
) {
  if (!Array.isArray(filteredFacts)) {
    throw new TypeError(
      'generateHypotheses expects an array of filtered facts.',
    );
  }
  if (!Array.isArray(blockedFactIds)) {
    throw new TypeError(
      'generateHypotheses expects blockedFactIds to be an array when provided.',
    );
  }

  const allowedFactIds = new Set(
    filteredFacts
      .map((fact) =>
        fact && typeof fact.fact_id === 'string' ? fact.fact_id : null,
      )
      .filter((factId) => factId !== null),
  );
  const blockedIds = new Set(
    blockedFactIds.filter((factId) => typeof factId === 'string'),
  );

  const result = await generateHypothesesWithChat({
    chatFn: chat,
    firstRequest: buildRequest(filteredFacts, false),
    retryRequest: buildRequest(filteredFacts, true),
    parseOptions: {
      allowedFactIds,
      blockedFactIds: blockedIds,
    },
    attemptTimeoutMs: LLM_TIMEOUT_MS,
    totalBudgetMs: LLM_TOTAL_BUDGET_MS,
    fallback: (error) => {
      const reason = errorMessage(error);
      console.warn(
        'Sentinel: Forge LLM unavailable; using deterministic mock hypotheses:',
        reason,
      );
      return mockResult(filteredFacts, reason);
    },
  });

  if (!result.fallback_used && result.diagnostics) {
    console.log(
      'Sentinel: Forge LLM finish_reason=%s output_tokens=%s retry_used=%s salvage_used=%s',
      result.diagnostics.finish_reason ?? 'unknown',
      result.diagnostics.output_tokens ?? 'unknown',
      result.diagnostics.retry_used,
      result.diagnostics.salvage_used,
    );
  }

  return result;
}
