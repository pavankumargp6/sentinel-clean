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
  createStoredRun,
  proposalFromStoredRun,
} from '../src/runStore.js';
import { createAuditRecord } from '../src/auditLog.js';
import { buildPostmortem } from '../src/postmortem.js';

const FIXED_NOW = 1760000000000;

function citationIds(citations) {
  return Array.from(
    new Set(
      citations
        .map((citation) =>
          citation && typeof citation.fact_id === 'string'
            ? citation.fact_id
            : null,
        )
        .filter((id) => id !== null),
    ),
  );
}

function scoredDemoRun() {
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
      valid_citation_ids: citationIds(result.valid_citations),
      rejected_citation_ids: citationIds(result.rejected_citations),
      blocked_citation_ids: citationIds(result.blocked_citations),
    };
  });

  return {
    facts,
    run: createStoredRun({
      hypotheses: rankHypotheses(scored),
      source: 'mock',
      model: 'deterministic-mock',
      fallback_used: true,
      fallback_reason: 'test fallback',
      created_at: new Date(FIXED_NOW).toISOString(),
    }),
  };
}

function demoProposal() {
  const { facts, run } = scoredDemoRun();
  const { proposal } = proposalFromStoredRun(run, {
    facts,
    now: FIXED_NOW,
  });
  return { facts, run, proposal };
}

test('postmortem contains all six required sections', () => {
  const { facts, run, proposal } = demoProposal();
  const postmortem = buildPostmortem({
    facts,
    run,
    proposal,
    audits: [],
    generated_at: new Date(FIXED_NOW).toISOString(),
  });

  assert.equal(postmortem.available, true);
  for (const section of [
    '## Summary',
    '## Timeline',
    '## Root Cause',
    '## Rejected Hypotheses',
    '## Decision Lineage',
    '## Action Items',
  ]) {
    assert.ok(
      postmortem.markdown.includes(section),
      `missing Markdown section ${section}`,
    );
  }

  assert.equal(
    postmortem.summary.top_hypothesis.hypothesis_id,
    run.hypotheses[0].hypothesis_id,
  );
  assert.equal(postmortem.summary.source_type, 'mock');
  assert.match(postmortem.summary.source, /Mock/);
  assert.equal(postmortem.root_cause.qualified, true);
  assert.ok(postmortem.root_cause.evidence.length > 0);
});

test('Summary and Root Cause Markdown report the same confidence', () => {
  const { facts, run, proposal } = demoProposal();
  const postmortem = buildPostmortem({ facts, run, proposal, audits: [] });

  assert.equal(postmortem.summary.confidence, postmortem.root_cause.confidence);
  assert.equal(postmortem.root_cause.confidence, run.hypotheses[0].confidence);

  const summarySection = postmortem.markdown
    .split('## Summary')[1]
    .split('## Timeline')[0];
  const rootCauseSection = postmortem.markdown
    .split('## Root Cause')[1]
    .split('## Rejected Hypotheses')[0];
  const expected = postmortem.summary.confidence.toFixed(2);
  const summaryMatch = summarySection.match(/\*\*Confidence:\*\* (\d+\.\d{2})/);
  const rootMatch = rootCauseSection.match(/- Confidence: \*\*(\d+\.\d{2})\*\*/);

  assert.ok(summaryMatch, 'Summary confidence line is missing');
  assert.ok(rootMatch, 'Root Cause confidence line is missing');
  assert.equal(summaryMatch[1], expected);
  assert.equal(rootMatch[1], expected);
  assert.equal(summaryMatch[1], rootMatch[1]);
});

test('timeline includes every fact sorted by observed_at, including remediation', () => {
  const { facts, run, proposal } = demoProposal();
  const postmortem = buildPostmortem({ facts, run, proposal, audits: [] });

  const observed = postmortem.timeline.map((fact) => fact.observed_at);
  assert.deepEqual(observed, [...observed].sort());
  assert.equal(postmortem.timeline.length, facts.length);
  assert.ok(
    postmortem.timeline.some(
      (fact) => fact.fact_id === 'fact_remediation_001' && fact.is_remediation,
    ),
  );
  assert.equal(postmortem.timeline[0].fact_id, 'fact_jira_change_001');
  assert.equal(
    postmortem.timeline[postmortem.timeline.length - 1].fact_id,
    'fact_remediation_001',
  );
  assert.match(postmortem.markdown, /response action — never a cause/);
});

test('remediation appears in the timeline but never in the root cause', () => {
  const { facts, run, proposal } = demoProposal();
  const postmortem = buildPostmortem({ facts, run, proposal, audits: [] });

  assert.ok(
    postmortem.timeline.some((fact) => fact.fact_id === 'fact_remediation_001'),
  );
  assert.ok(
    !postmortem.root_cause.evidence.some(
      (evidence) => evidence.fact_id === 'fact_remediation_001',
    ),
  );

  const rootCauseSection = postmortem.markdown
    .split('## Root Cause')[1]
    .split('## Rejected Hypotheses')[0];
  assert.doesNotMatch(rootCauseSection, /fact_remediation_001/);
});

test('a malformed stored run that cites remediation is still filtered', () => {
  const facts = buildDemoScenario(FIXED_NOW);
  const hypotheses = rankHypotheses([
    {
      hypothesis_id: 'hypothesis_remediation_top',
      summary: 'The restart fixed the incident.',
      confidence: 0.9,
      insufficient_evidence: false,
      corroboration: 1,
      causal_cluster_count: 1,
      citations: [
        {
          fact_id: 'fact_remediation_001',
          stance: 'supports',
          role: 'causal',
        },
        {
          fact_id: 'fact_deploy_root_001',
          stance: 'supports',
          role: 'causal',
        },
      ],
      valid_citation_ids: ['fact_remediation_001', 'fact_deploy_root_001'],
      rejected_citation_ids: [],
      blocked_citation_ids: ['fact_remediation_001'],
    },
  ]);
  const run = createStoredRun({
    hypotheses,
    source: 'mock',
    model: 'deterministic-mock',
    created_at: new Date(FIXED_NOW).toISOString(),
  });

  const postmortem = buildPostmortem({ facts, run, audits: [] });

  assert.ok(
    !postmortem.root_cause.evidence.some(
      (evidence) => evidence.fact_id === 'fact_remediation_001',
    ),
  );
  assert.ok(
    postmortem.root_cause.omitted_fact_ids.includes('fact_remediation_001'),
  );
  assert.match(
    postmortem.markdown,
    /Remediation or unresolvable citations were omitted from the root cause/,
  );
});

test('rejected-hypothesis reasons are derived from stored citations and scores', () => {
  const facts = buildDemoScenario(FIXED_NOW);
  const hypotheses = rankHypotheses([
    {
      hypothesis_id: 'hypothesis_top',
      summary: 'The deploy is the cause.',
      confidence: 0.9,
      insufficient_evidence: false,
      citations: [
        {
          fact_id: 'fact_deploy_root_001',
          stance: 'supports',
          role: 'causal',
        },
      ],
      rejected_citation_ids: [],
      blocked_citation_ids: [],
    },
    {
      hypothesis_id: 'hypothesis_contradicted',
      summary: 'A contradicted hypothesis.',
      confidence: 0.1,
      insufficient_evidence: true,
      citations: [
        {
          fact_id: 'fact_deploy_decoy_001',
          stance: 'contradicts',
          role: 'causal',
        },
      ],
      rejected_citation_ids: [],
      blocked_citation_ids: [],
    },
    {
      hypothesis_id: 'hypothesis_missing',
      summary: 'A hypothesis that invented evidence.',
      confidence: 0.2,
      insufficient_evidence: true,
      citations: [],
      rejected_citation_ids: ['fact_does_not_exist_999'],
      blocked_citation_ids: [],
    },
    {
      hypothesis_id: 'hypothesis_blocked',
      summary: 'A hypothesis that cited a remediation action.',
      confidence: 0.3,
      insufficient_evidence: false,
      citations: [],
      rejected_citation_ids: [],
      blocked_citation_ids: ['fact_remediation_001'],
    },
    {
      hypothesis_id: 'hypothesis_weak',
      summary: 'A hypothesis with too little evidence.',
      confidence: 0.1,
      insufficient_evidence: true,
      citations: [],
      rejected_citation_ids: [],
      blocked_citation_ids: [],
    },
  ]);
  const run = createStoredRun({
    hypotheses,
    source: 'mock',
    model: 'deterministic-mock',
    created_at: new Date(FIXED_NOW).toISOString(),
  });

  const postmortem = buildPostmortem({ facts, run, audits: [] });
  const reasons = new Map(
    postmortem.rejected_hypotheses.map((hypothesis) => [
      hypothesis.hypothesis_id,
      hypothesis.reason,
    ]),
  );

  assert.match(
    reasons.get('hypothesis_contradicted'),
    /contradicted by fact_deploy_decoy_001/,
  );
  assert.match(
    reasons.get('hypothesis_missing'),
    /citations rejected as nonexistent: fact_does_not_exist_999/,
  );
  assert.match(
    reasons.get('hypothesis_blocked'),
    /Causal Inversion Guard: fact_remediation_001/,
  );
  assert.match(reasons.get('hypothesis_weak'), /insufficient evidence/);
  assert.equal(postmortem.rejected_hypotheses.length, 4);
});

test('decision lineage matches the audit records for the latest proposal', () => {
  const { facts, run, proposal } = demoProposal();
  const matchingApprove = createAuditRecord({
    proposal,
    topHypothesis: run.hypotheses[0],
    decision: 'approve',
    note: 'Looks safe',
    decidedBy: 'account-123',
    now: FIXED_NOW + 1000,
    suffix: 'a',
  });
  const matchingReject = createAuditRecord({
    proposal,
    topHypothesis: run.hypotheses[0],
    decision: 'reject',
    decidedBy: 'account-456',
    now: FIXED_NOW + 2000,
    suffix: 'b',
  });
  const unrelated = createAuditRecord({
    proposal: {
      ...proposal,
      proposal_id: 'proposal_unrelated',
      hypothesis_id: 'hypothesis_unrelated',
      evidence_fact_ids: [],
    },
    decision: 'approve',
    decidedBy: 'account-789',
    now: FIXED_NOW + 3000,
    suffix: 'c',
  });

  const postmortem = buildPostmortem({
    facts,
    run,
    proposal,
    audits: [unrelated, matchingReject, matchingApprove],
  });

  assert.equal(postmortem.decision_lineage.length, 2);
  assert.deepEqual(
    postmortem.decision_lineage.map((audit) => audit.decision),
    ['approve', 'reject'],
  );
  assert.equal(postmortem.decision_lineage[0].audit_id, matchingApprove.audit_id);
  assert.equal(postmortem.decision_lineage[0].decided_by, 'account-123');
  assert.equal(
    postmortem.decision_lineage[0].confidence_at_decision,
    run.hypotheses[0].confidence,
  );
  assert.deepEqual(
    postmortem.decision_lineage[0].evidence_fact_ids,
    proposal.evidence_fact_ids,
  );
  assert.equal(postmortem.decision_lineage[0].note, 'Looks safe');
  assert.match(postmortem.markdown, /\| approve \|/);
});

test('decision lineage survives a proposal regenerated for the same run', () => {
  const { facts, run, proposal } = demoProposal();
  const originalAudit = createAuditRecord({
    proposal,
    topHypothesis: run.hypotheses[0],
    decision: 'approve',
    note: 'Approved before regeneration',
    decidedBy: 'account-123',
    now: FIXED_NOW + 1000,
    suffix: 'a',
  });
  const regeneratedProposal = {
    ...proposal,
    proposal_id: 'proposal_regenerated_same_run',
  };

  const postmortem = buildPostmortem({
    facts,
    run,
    proposal: regeneratedProposal,
    audits: [originalAudit],
  });

  assert.equal(postmortem.decision_lineage.length, 1);
  assert.equal(
    postmortem.decision_lineage[0].audit_id,
    originalAudit.audit_id,
  );
  assert.equal(postmortem.decision_lineage[0].decision, 'approve');
});

test('decision lineage falls back to the run window when no proposal exists', () => {
  const { facts, run, proposal } = demoProposal();
  const matching = createAuditRecord({
    proposal,
    topHypothesis: run.hypotheses[0],
    decision: 'approve',
    decidedBy: 'account-123',
    now: FIXED_NOW + 1000,
    suffix: 'a',
  });
  const beforeRun = createAuditRecord({
    proposal,
    topHypothesis: run.hypotheses[0],
    decision: 'reject',
    decidedBy: 'account-456',
    now: FIXED_NOW - 1000,
    suffix: 'b',
  });

  const postmortem = buildPostmortem({
    facts,
    run,
    proposal: null,
    audits: [matching, beforeRun],
  });

  assert.equal(postmortem.decision_lineage.length, 1);
  assert.equal(postmortem.decision_lineage[0].audit_id, matching.audit_id);
  assert.deepEqual(postmortem.action_items, []);
  assert.match(
    postmortem.markdown,
    /No action items: no qualifying proposal is stored for this run/,
  );
});

test('action items are suggestions derived from the stored proposal', () => {
  const { facts, run, proposal } = demoProposal();
  const postmortem = buildPostmortem({ facts, run, proposal, audits: [] });

  assert.equal(postmortem.action_items.length, 2);
  assert.match(postmortem.action_items[0].text, /Roll back checkout-service/);
  assert.match(postmortem.action_items[0].text, /human-executed/);
  assert.match(postmortem.action_items[1].text, /Review change OPS-1421/);
  assert.match(
    postmortem.markdown,
    /These are suggestions derived from the stored proposal/,
  );
  assert.match(postmortem.markdown, /Sentinel does not execute them/);
});

test('no-run case returns a clear message and no invented incident', () => {
  const postmortem = buildPostmortem({
    facts: buildDemoScenario(FIXED_NOW),
    run: null,
    proposal: null,
    audits: [],
  });

  assert.equal(postmortem.available, false);
  assert.match(postmortem.reason, /Run the Hypothesis Engine first/);
  assert.match(postmortem.markdown, /Run the Hypothesis Engine first/);
  assert.deepEqual(postmortem.timeline, []);
  assert.equal(postmortem.summary, null);
  assert.equal(postmortem.root_cause, null);
  assert.deepEqual(postmortem.action_items, []);
});
