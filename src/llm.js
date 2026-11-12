/**
 * Optional Forge LLM hypothesis generator.
 *
 * This is the only Sentinel module that imports `@forge/llm` or calls a model.
 * The deterministic scoring pipeline remains authoritative: model output is
 * parsed into the same hypothesis shape the mock produces, and then scored by
 * `src/scoring.js`.
 *
 * `@forge/llm` requires the Forge runtime, so tests must import the pure parser
 * from `src/llmParser.js` instead of this file.
 */
import { chat } from '@forge/llm';

import { generateMockHypotheses } from './mockLLM.js';
import {
  contentToText,
  parseHypotheses,
  toPromptFacts,
} from './llmParser.js';

// Change the model here. Keep it as a single constant so upgrades are explicit.
export const MODEL_ID = 'claude-sonnet-4-6';
export const MAX_COMPLETION_TOKENS = 800;
export const TEMPERATURE = 0;

// The bridge/resolver invocation limit is 25 seconds. Leave ample headroom for
// the KVS reads before and the deterministic scoring after the model call.
export const LLM_TIMEOUT_MS = 15000;

const MAX_FALLBACK_REASON_LENGTH = 300;

const SYSTEM_PROMPT = `You are Sentinel, an incident-analysis assistant.
You receive a JSON array of verified incident facts. Propose 2-3 candidate root-cause hypotheses.

Rules:
- Return JSON only. No prose, no markdown, and no code fences.
- Return a JSON array. Each item must have exactly these fields:
  "hypothesis_id" (unique non-empty string),
  "summary" (non-empty string),
  "citations" (array of citation objects).
- Each citation must have "hypothesis_id", "fact_id", and "stance".
- Cite only fact_id values present in the provided facts. Never invent facts or fact IDs.
- "stance" must be exactly "supports" or "contradicts".
- Do not include a confidence, probability, or score. The application calculates confidence deterministically.
- Every hypothesis must cite at least one provided fact.`;

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_FALLBACK_REASON_LENGTH
    ? `${message.slice(0, MAX_FALLBACK_REASON_LENGTH)}...`
    : message;
}

function withTimeout(promise, milliseconds) {
  let timer;

  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Forge LLM call timed out after ${milliseconds} ms.`));
    }, milliseconds);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function buildMessages(filteredFacts) {
  return [
    {
      role: 'system',
      content: SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: [
        'Incident facts:',
        JSON.stringify(toPromptFacts(filteredFacts), null, 2),
        '',
        'Return the JSON array now.',
      ].join('\n'),
    },
  ];
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
 * mock on timeout, transport error, empty content, or unusable JSON.
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

  try {
    const response = await withTimeout(
      chat({
        model: MODEL_ID,
        messages: buildMessages(filteredFacts),
        temperature: TEMPERATURE,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
      }),
      LLM_TIMEOUT_MS,
    );

    const content = response?.choices?.[0]?.message?.content;
    if (content === undefined || content === null || content === '') {
      throw new Error('Forge LLM returned no message content.');
    }

    const hypotheses = parseHypotheses(contentToText(content), {
      allowedFactIds,
      blockedFactIds: blockedIds,
    });

    if (hypotheses.length === 0) {
      throw new Error('Forge LLM returned no usable hypotheses.');
    }

    return {
      hypotheses,
      source: 'llm',
      model: MODEL_ID,
      fallback_used: false,
    };
  } catch (error) {
    const reason = errorMessage(error);
    console.warn(
      'Sentinel: Forge LLM unavailable; using deterministic mock hypotheses:',
      reason,
    );
    return mockResult(filteredFacts, reason);
  }
}
