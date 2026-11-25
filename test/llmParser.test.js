import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDemoScenario } from '../src/fixtures.js';
import {
  contentToText,
  parseHypotheses,
  parseHypothesesDetailed,
  salvageHypotheses,
  stripCodeFences,
  toPromptFacts,
} from '../src/llmParser.js';

const FIXED_NOW = 1760000000000;
const facts = buildDemoScenario(FIXED_NOW);
const allowedFactIds = facts
  .filter((fact) => fact.fact_type !== 'remediation_action')
  .map((fact) => fact.fact_id);

function citation(factId, stance = 'supports') {
  return {
    hypothesis_id: 'hypothesis_checkout_v2140',
    fact_id: factId,
    stance,
  };
}

function validHypothesis(overrides = {}) {
  return {
    hypothesis_id: 'hypothesis_checkout_v2140',
    summary: 'The checkout-service v2.14.0 deploy caused the latency.',
    citations: [citation('fact_deploy_root_001')],
    ...overrides,
  };
}

test('parses valid JSON and drops model-provided confidence', () => {
  const content = JSON.stringify([
    validHypothesis({ confidence: 0.99, notes: 'ignore me' }),
  ]);

  const parsed = parseHypotheses(content, { allowedFactIds });

  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], validHypothesis());
  assert.equal(parsed[0].confidence, undefined);
  assert.equal(parsed[0].notes, undefined);
});

test('parses JSON wrapped in a Markdown code fence', () => {
  const json = JSON.stringify([validHypothesis()]);
  const content = `Here is the result:\n\n\`\`\`json\n${json}\n\`\`\`\n`;

  assert.equal(stripCodeFences(content), json);
  assert.deepEqual(parseHypotheses(content, { allowedFactIds }), [
    validHypothesis(),
  ]);
});

test('rejects malformed JSON so the caller can fall back', () => {
  assert.throws(
    () => parseHypotheses('{"hypotheses": [', { allowedFactIds }),
    /did not return valid JSON/,
  );
  assert.throws(
    () =>
      parseHypotheses('The incident was caused by a deploy.', {
        allowedFactIds,
      }),
    /did not return valid JSON/,
  );
});

test('salvages complete hypotheses from truncated JSON and drops the partial one', () => {
  const first = validHypothesis({ hypothesis_id: 'hypothesis_first' });
  const second = validHypothesis({ hypothesis_id: 'hypothesis_second' });
  const partial =
    '{"hypothesis_id":"hypothesis_partial","summary":"The partial one","citations":[{"hypothesis_id":"hypothesis_partial","fact_id":"fact_deploy_root_001","stance":"supp';
  const content = `[${JSON.stringify(first)},${JSON.stringify(
    second,
  )},${partial}`;

  const parsed = parseHypothesesDetailed(content, { allowedFactIds });

  assert.equal(parsed.salvage_used, true);
  assert.deepEqual(
    parsed.hypotheses.map((hypothesis) => hypothesis.hypothesis_id),
    ['hypothesis_first', 'hypothesis_second'],
  );
  assert.equal(parsed.hypotheses.length, 2);
});

test('does not accept a citation whose parent hypothesis is truncated', () => {
  const complete = validHypothesis({ hypothesis_id: 'hypothesis_complete' });
  const truncatedParent =
    '{"hypothesis_id":"hypothesis_incomplete","summary":"Incomplete","citations":[{"hypothesis_id":"hypothesis_incomplete","fact_id":"fact_deploy_root_001","stance":"supports"}]';
  const content = `[${JSON.stringify(complete)},${truncatedParent}`;

  const parsed = parseHypothesesDetailed(content, { allowedFactIds });

  assert.equal(parsed.salvage_used, true);
  assert.deepEqual(
    parsed.hypotheses.map((hypothesis) => hypothesis.hypothesis_id),
    ['hypothesis_complete'],
  );
  assert.equal(parsed.hypotheses[0].citations.length, 1);
});

test('salvage still drops unknown and remediation fact IDs', () => {
  const hypothesis = validHypothesis({
    hypothesis_id: 'hypothesis_salvaged',
    citations: [
      citation('fact_does_not_exist_999'),
      citation('fact_remediation_001'),
      citation('fact_deploy_root_001'),
    ],
  });
  const content = `[${JSON.stringify(hypothesis)},{"hypothesis_id":"partial"`;

  const salvaged = salvageHypotheses(content, {
    allowedFactIds: [...allowedFactIds, 'fact_remediation_001'],
    blockedFactIds: ['fact_remediation_001'],
  });

  assert.equal(salvaged.length, 1);
  assert.deepEqual(
    salvaged[0].citations.map((item) => item.fact_id),
    ['fact_deploy_root_001'],
  );
});

test('discards citations to unknown fact IDs', () => {
  const content = JSON.stringify([
    validHypothesis({
      citations: [
        citation('fact_does_not_exist_999'),
        citation('fact_jira_change_001'),
      ],
    }),
  ]);

  const parsed = parseHypotheses(content, { allowedFactIds });

  assert.deepEqual(
    parsed[0].citations.map((item) => item.fact_id),
    ['fact_jira_change_001'],
  );
});

test('discards remediation fact citations even when present in the allowed set', () => {
  const content = JSON.stringify([
    validHypothesis({
      citations: [
        citation('fact_remediation_001'),
        citation('fact_deploy_root_001'),
      ],
    }),
  ]);

  const parsed = parseHypotheses(content, {
    allowedFactIds: [...allowedFactIds, 'fact_remediation_001'],
    blockedFactIds: ['fact_remediation_001'],
  });

  assert.deepEqual(
    parsed[0].citations.map((item) => item.fact_id),
    ['fact_deploy_root_001'],
  );
});

test('parses content supplied as ContentPart[]', () => {
  const json = JSON.stringify([validHypothesis()]);
  const splitAt = Math.floor(json.length / 2);
  const content = [
    { type: 'text', text: json.slice(0, splitAt) },
    { type: 'text', text: json.slice(splitAt) },
  ];

  assert.equal(contentToText(content), json);
  assert.deepEqual(parseHypotheses(content, { allowedFactIds }), [
    validHypothesis(),
  ]);
});

test('drops malformed hypotheses and invalid citations but keeps usable items', () => {
  const content = JSON.stringify([
    validHypothesis(),
    {
      hypothesis_id: 'hypothesis_missing_summary',
      summary: '',
      citations: [],
    },
    {
      hypothesis_id: 'hypothesis_bad_citations',
      summary: 'Citations are not an array.',
      citations: 'nope',
    },
    {
      hypothesis_id: 'hypothesis_mixed_stances',
      summary: 'The deploy caused the latency.',
      citations: [
        citation('fact_deploy_root_001', 'maybe'),
        citation('fact_jira_change_001', 'contradicts'),
      ],
    },
    validHypothesis(),
  ]);

  const parsed = parseHypotheses(content, { allowedFactIds });

  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].hypothesis_id, 'hypothesis_mixed_stances');
  assert.deepEqual(parsed[1].citations, [
    {
      hypothesis_id: 'hypothesis_mixed_stances',
      fact_id: 'fact_jira_change_001',
      stance: 'contradicts',
    },
  ]);
});

test('prompt facts expose only the allowed fields', () => {
  const promptFacts = toPromptFacts(facts);

  assert.equal(promptFacts.length, facts.length);
  for (const fact of promptFacts) {
    assert.deepEqual(Object.keys(fact).sort(), [
      'fact_id',
      'fact_type',
      'observed_at',
      'summary',
      'weight',
    ]);
    assert.equal(
      Object.prototype.hasOwnProperty.call(fact, 'source_ref'),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(fact, 'environment'),
      false,
    );
    assert.equal(Object.prototype.hasOwnProperty.call(fact, 'cluster'), false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(fact, 'service_scope'),
      false,
    );
  }
});
