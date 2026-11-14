import test from 'node:test';
import assert from 'node:assert/strict';

import { BLAST_RADIUS, buildDemoScenario } from '../src/fixtures.js';
import {
  applyCausalInversionGuard,
  calculateConfidence,
  rankHypotheses,
} from '../src/scoring.js';
import { generateMockHypotheses } from '../src/mockLLM.js';
import {
  buildProposal,
  buildTopProposal,
  proposalIdFromKey,
  proposalKey,
} from '../src/remediation.js';

const FIXED_NOW = 1760000000000;

function scoredHypotheses() {
  const facts = buildDemoScenario(FIXED_NOW);
  const hypotheses = generateMockHypotheses(applyCausalInversionGuard(facts));
  const scored = hypotheses.map((hypothesis) => {
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
  return { facts, hypotheses: rankHypotheses(scored) };
}

test('buildProposal creates a rollback proposal for the qualifying top hypothesis', () => {
  const { facts, hypotheses } = scoredHypotheses();
  const top = hypotheses[0];
  const { proposal, reason } = buildProposal(top, { facts, now: FIXED_NOW });

  assert.equal(reason, undefined);
  assert.equal(proposal.hypothesis_id, top.hypothesis_id);
  assert.equal(proposal.action, 'rollback');
  assert.equal(proposal.target, 'checkout-service');
  assert.ok(proposal.proposal_id.startsWith('proposal_hypothesis_checkout_v2140_'));
  assert.ok(proposal.evidence_fact_ids.includes('fact_deploy_root_001'));
  assert.ok(proposal.evidence_fact_ids.includes('fact_jira_change_001'));
  assert.ok(
    proposal.blast_radius.some((row) => row.service === 'checkout-service'),
  );
  assert.ok(proposal.instructions.includes('Human-executed rollback instructions'));
  assert.ok(proposal.instructions.includes('This app does not perform the rollback'));
  assert.ok(proposal.diff.includes('Rollback diff'));
  assert.equal(proposal.confidence, top.confidence);
});

test('buildProposal returns insufficient evidence for a low-confidence hypothesis', () => {
  const { facts, hypotheses } = scoredHypotheses();
  const low = hypotheses.find((hypothesis) => hypothesis.confidence < 0.5);

  const result = buildProposal(low, { facts, now: FIXED_NOW });

  assert.equal(result.proposal, null);
  assert.equal(result.reason, 'insufficient evidence');
});

test('buildProposal handles null and malformed hypotheses', () => {
  assert.deepEqual(buildProposal(null), {
    proposal: null,
    reason: 'insufficient evidence',
  });
  assert.deepEqual(buildProposal({}), {
    proposal: null,
    reason: 'insufficient evidence',
  });
});

test('buildTopProposal picks the rank-1 hypothesis', () => {
  const { facts, hypotheses } = scoredHypotheses();
  const { proposal } = buildTopProposal(hypotheses, { facts, now: FIXED_NOW });

  assert.equal(proposal.hypothesis_id, hypotheses[0].hypothesis_id);
  assert.equal(buildTopProposal([], { facts }).proposal, null);
});

test('blast radius comes from the seeded fixture table', () => {
  const { facts, hypotheses } = scoredHypotheses();
  const { proposal } = buildProposal(hypotheses[0], { facts, now: FIXED_NOW });
  const checkout = proposal.blast_radius.find(
    (row) => row.service === 'checkout-service',
  );

  assert.ok(checkout);
  assert.equal(checkout.owner, BLAST_RADIUS['checkout-service'].owner);
  assert.deepEqual(checkout.dependents, [
    ...BLAST_RADIUS['checkout-service'].dependents,
  ]);
});

test('proposal storage key round-trips and is deterministic', () => {
  const { facts, hypotheses } = scoredHypotheses();
  const { proposal } = buildProposal(hypotheses[0], { facts, now: FIXED_NOW });
  const key = proposalKey(proposal.proposal_id);

  assert.ok(key.startsWith('sentinel:proposal:'));
  assert.equal(proposalIdFromKey(key), proposal.proposal_id);
});
