import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDemoScenario } from '../src/fixtures.js';
import {
  finishReasonOf,
  generateHypothesesWithChat,
  isTruncationFinish,
} from '../src/llmRun.js';

const FIXED_NOW = 1760000000000;
const facts = buildDemoScenario(FIXED_NOW);
const allowedFactIds = facts
  .filter((fact) => fact.fact_type !== 'remediation_action')
  .map((fact) => fact.fact_id);

const parseOptions = { allowedFactIds };

function hypothesis(hypothesisId = 'hypothesis_checkout_v2140') {
  return {
    hypothesis_id: hypothesisId,
    summary: 'The checkout-service deploy caused the latency.',
    citations: [
      {
        hypothesis_id: hypothesisId,
        fact_id: 'fact_deploy_root_001',
        stance: 'supports',
      },
    ],
  };
}

function response(content, finishReason = 'stop') {
  return {
    choices: [
      {
        finish_reason: finishReason,
        message: { role: 'assistant', content },
      },
    ],
    usage: { output_tokens: 42 },
  };
}

function request(marker) {
  return {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: marker }],
  };
}

test('reads and classifies the documented finish_reason field', () => {
  assert.equal(finishReasonOf(response('{}', 'length')), 'length');
  assert.equal(isTruncationFinish(response('{}', 'length')), true);
  assert.equal(isTruncationFinish(response('{}', 'max_tokens')), true);
  assert.equal(isTruncationFinish(response('{}', 'stop')), false);
  assert.equal(isTruncationFinish({ choices: [] }), false);
});

test('finish_reason length triggers one retry with the tighter request', async () => {
  const calls = [];
  const truncated = JSON.stringify([hypothesis()]).slice(0, 60);
  const chatFn = async (chatRequest) => {
    calls.push(chatRequest);
    return calls.length === 1
      ? response(truncated, 'length')
      : response(JSON.stringify([hypothesis()]), 'stop');
  };

  const result = await generateHypothesesWithChat({
    chatFn,
    firstRequest: request('first'),
    retryRequest: request('retry'),
    parseOptions,
    fallback: () => {
      throw new Error('fallback should not run');
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].messages[0].content, 'retry');
  assert.equal(result.source, 'llm');
  assert.equal(result.fallback_used, false);
  assert.equal(result.diagnostics.retry_used, true);
  assert.equal(result.diagnostics.finish_reason, 'stop');
  assert.equal(result.hypotheses.length, 1);
});

test('a second truncation falls back with the exact truncation reason', async () => {
  let calls = 0;
  const truncated = JSON.stringify([hypothesis()]).slice(0, 60);
  const chatFn = async () => {
    calls += 1;
    return response(truncated, 'length');
  };

  const result = await generateHypothesesWithChat({
    chatFn,
    firstRequest: request('first'),
    retryRequest: request('retry'),
    parseOptions,
    fallback: (error) => ({
      hypotheses: [],
      source: 'mock',
      model: 'deterministic-mock',
      fallback_used: true,
      fallback_reason: error.message,
    }),
  });

  assert.equal(calls, 2);
  assert.equal(result.fallback_used, true);
  assert.match(result.fallback_reason, /truncated/);
  assert.match(result.fallback_reason, /finish_reason: length/);
});

test('fully malformed JSON still falls back without a retry', async () => {
  let calls = 0;
  const chatFn = async () => {
    calls += 1;
    return response('The incident was caused by a deploy.', 'stop');
  };

  const result = await generateHypothesesWithChat({
    chatFn,
    firstRequest: request('first'),
    retryRequest: request('retry'),
    parseOptions,
    fallback: (error) => ({
      hypotheses: [],
      source: 'mock',
      model: 'deterministic-mock',
      fallback_used: true,
      fallback_reason: error.message,
    }),
  });

  assert.equal(calls, 1);
  assert.equal(result.fallback_used, true);
  assert.match(result.fallback_reason, /did not return valid JSON/);
});

test('complete objects in truncated JSON are salvaged before falling back', async () => {
  let calls = 0;
  const first = hypothesis('hypothesis_first');
  const second = hypothesis('hypothesis_second');
  const partial = '{"hypothesis_id":"hypothesis_partial","summary":"partial"';
  const content = `[${JSON.stringify(first)},${JSON.stringify(
    second,
  )},${partial}`;

  const result = await generateHypothesesWithChat({
    chatFn: async () => {
      calls += 1;
      return calls === 1
        ? response(content, 'length')
        : response('not json at all', 'stop');
    },
    firstRequest: request('first'),
    retryRequest: request('retry'),
    parseOptions,
    fallback: () => {
      throw new Error('fallback should not run');
    },
  });

  assert.equal(result.fallback_used, false);
  assert.equal(result.diagnostics.retry_used, true);
  assert.equal(result.diagnostics.retry_failed, true);
  assert.equal(result.diagnostics.salvage_used, true);
  assert.deepEqual(
    result.hypotheses.map((item) => item.hypothesis_id),
    ['hypothesis_first', 'hypothesis_second'],
  );
});

test('unknown and remediation fact IDs are still dropped on the LLM path', async () => {
  const content = JSON.stringify([
    {
      ...hypothesis(),
      citations: [
        {
          hypothesis_id: 'hypothesis_checkout_v2140',
          fact_id: 'fact_does_not_exist_999',
          stance: 'supports',
        },
        {
          hypothesis_id: 'hypothesis_checkout_v2140',
          fact_id: 'fact_remediation_001',
          stance: 'supports',
        },
        {
          hypothesis_id: 'hypothesis_checkout_v2140',
          fact_id: 'fact_deploy_root_001',
          stance: 'supports',
        },
      ],
    },
  ]);

  const result = await generateHypothesesWithChat({
    chatFn: async () => response(content, 'stop'),
    firstRequest: request('first'),
    retryRequest: request('retry'),
    parseOptions: {
      allowedFactIds: [...allowedFactIds, 'fact_remediation_001'],
      blockedFactIds: ['fact_remediation_001'],
    },
    fallback: () => {
      throw new Error('fallback should not run');
    },
  });

  assert.equal(result.fallback_used, false);
  assert.deepEqual(
    result.hypotheses[0].citations.map((citation) => citation.fact_id),
    ['fact_deploy_root_001'],
  );
});
