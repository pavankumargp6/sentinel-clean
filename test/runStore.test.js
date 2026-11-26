import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDemoScenario } from '../src/fixtures.js';
import {
  applyCausalInversionGuard,
  calculateConfidence,
  rankHypotheses,
} from '../src/scoring.js';
import { generateMockHypotheses } from '../src/mockLLM.js';
import {
  LAST_PROPOSAL_KEY,
  LAST_RUN_KEY,
  createProposalPointer,
  createStoredRun,
  isProposalPointer,
  isStoredRun,
  proposalFromStoredRun,
} from '../src/runStore.js';

const FIXED_NOW = 1760000000000;

function scoredRun() {
  const facts = buildDemoScenario(FIXED_NOW);
  const raw = generateMockHypotheses(applyCausalInversionGuard(facts));
  const scored = raw.map((hypothesis) => {
    const result = calculateConfidence(hypothesis, facts);
    return {
      hypothesis_id: hypothesis.hypothesis_id,
      summary: hypothesis.summary,
      confidence: result.confidence,
      insufficient_evidence: result.insufficient_evidence,
      corroboration: result.corroboration,
      causal_cluster_count: result.causal_cluster_count,
      citations: result.valid_citations.map((citation) => ({
        fact_id: citation.fact_id,
        stance: citation.stance,
        role: citation.role,
      })),
    };
  });

  return {
    facts,
    run: createStoredRun({
      hypotheses: rankHypotheses(scored),
      source: 'mock',
      model: 'deterministic-mock',
      fallback_used: true,
      fallback_reason: 'test truncation',
      created_at: new Date(FIXED_NOW).toISOString(),
    }),
  };
}

test('creates the single stored-run shape and validates it', () => {
  const { run } = scoredRun();

  assert.equal(LAST_RUN_KEY, 'sentinel:last_run');
  assert.equal(run.version, 1);
  assert.equal(run.source, 'mock');
  assert.equal(run.model, 'deterministic-mock');
  assert.equal(run.fallback_used, true);
  assert.equal(run.fallback_reason, 'test truncation');
  assert.equal(run.created_at, new Date(FIXED_NOW).toISOString());
  assert.equal(run.count, 3);
  assert.equal(isStoredRun(run), true);
});

test('rejects malformed stored runs', () => {
  assert.equal(isStoredRun(null), false);
  assert.equal(isStoredRun({}), false);
  assert.equal(
    isStoredRun({
      version: 99,
      created_at: new Date(FIXED_NOW).toISOString(),
      source: 'mock',
      model: 'deterministic-mock',
      hypotheses: [{}],
    }),
    false,
  );
  assert.equal(
    isStoredRun({
      version: 1,
      created_at: new Date(FIXED_NOW).toISOString(),
      source: 'other',
      model: 'deterministic-mock',
      hypotheses: [{}],
    }),
    false,
  );
  assert.equal(
    isStoredRun({
      version: 1,
      created_at: new Date(FIXED_NOW).toISOString(),
      source: 'mock',
      model: 'deterministic-mock',
      hypotheses: [],
    }),
    false,
  );
});

test('proposal builder uses the stored run and its rank-1 hypothesis', () => {
  const { facts, run } = scoredRun();
  const result = proposalFromStoredRun(run, { facts, now: FIXED_NOW });

  assert.ok(result.proposal);
  assert.equal(result.proposal.hypothesis_id, run.hypotheses[0].hypothesis_id);
  assert.equal(result.proposal.action, 'rollback');
  assert.equal(result.proposal.target, 'checkout-service');
  assert.equal(result.top_hypothesis.hypothesis_id, run.hypotheses[0].hypothesis_id);
  assert.equal(result.reason, null);
});

test('proposal builder asks for a run when none is stored', () => {
  const result = proposalFromStoredRun(null, { facts: [], now: FIXED_NOW });

  assert.equal(result.proposal, null);
  assert.equal(result.top_hypothesis, null);
  assert.match(result.reason, /Run the Hypothesis Engine first/);
});

test('createStoredRun rejects empty hypotheses and invalid sources', () => {
  assert.throws(
    () => createStoredRun({ hypotheses: [], source: 'mock', model: 'm' }),
    /non-empty array/,
  );
  assert.throws(
    () => createStoredRun({ hypotheses: [{}], source: 'other', model: 'm' }),
    /source/,
  );
});

test('proposal pointer identifies the latest proposal without copying its body', () => {
  const createdAt = new Date(FIXED_NOW).toISOString();
  const pointer = createProposalPointer({
    proposalId: 'proposal_abc',
    createdAt,
  });

  assert.equal(LAST_PROPOSAL_KEY, 'sentinel:last_proposal');
  assert.deepEqual(pointer, {
    version: 1,
    proposal_id: 'proposal_abc',
    created_at: createdAt,
  });
  assert.equal(isProposalPointer(pointer), true);
  assert.equal(isProposalPointer(null), false);
  assert.equal(isProposalPointer([]), false);
  assert.equal(isProposalPointer({ ...pointer, version: 2 }), false);
  assert.equal(isProposalPointer({ ...pointer, proposal_id: '' }), false);
  assert.throws(() => createProposalPointer({ proposalId: '' }), /proposalId/);
});
