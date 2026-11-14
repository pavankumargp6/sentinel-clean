import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIT_INDEX_KEY,
  auditIdFromKey,
  auditKey,
  buildAuditId,
  createAuditRecord,
  validateAuditRecord,
} from '../src/auditLog.js';

const FIXED_NOW = 1760000000000;

const proposal = {
  proposal_id: 'proposal_hypothesis_checkout_v2140_2026-11-13T00-00-00-000Z',
  hypothesis_id: 'hypothesis_checkout_v2140',
  action: 'rollback',
  target: 'checkout-service',
  evidence_fact_ids: ['fact_deploy_root_001', 'fact_jira_change_001'],
  confidence: 0.6336,
  blast_radius: [],
};

test('buildAuditId is deterministic and includes a timestamp suffix', () => {
  const first = buildAuditId(FIXED_NOW, 'suffix-a');
  const second = buildAuditId(FIXED_NOW, 'suffix-a');
  const different = buildAuditId(FIXED_NOW, 'suffix-b');

  assert.equal(first, second);
  assert.notEqual(first, different);
  assert.ok(first.startsWith('audit_'));
  assert.ok(first.includes('suffix-a'));
});

test('audit storage key round-trips', () => {
  const auditId = buildAuditId(FIXED_NOW, 'suffix-a');
  const key = auditKey(auditId);

  assert.ok(key.startsWith('sentinel:audit:'));
  assert.equal(auditIdFromKey(key), auditId);
  assert.equal(AUDIT_INDEX_KEY, 'sentinel:audit:index');
});

test('createAuditRecord builds the expected append-only audit shape', () => {
  const record = createAuditRecord({
    proposal,
    topHypothesis: { confidence: 0.6336 },
    decision: 'approve',
    note: 'Rollback looks safe',
    decidedBy: 'account-123',
    now: FIXED_NOW,
    suffix: 'suffix-a',
  });

  assert.equal(record.audit_id, buildAuditId(FIXED_NOW, 'suffix-a'));
  assert.equal(record.proposal_id, proposal.proposal_id);
  assert.equal(record.hypothesis_id, proposal.hypothesis_id);
  assert.equal(record.decision, 'approve');
  assert.equal(record.decided_at, new Date(FIXED_NOW).toISOString());
  assert.equal(record.decided_by, 'account-123');
  assert.deepEqual(record.evidence_fact_ids, proposal.evidence_fact_ids);
  assert.equal(record.confidence_at_decision, 0.6336);
  assert.equal(record.note, 'Rollback looks safe');
  assert.equal(validateAuditRecord(record), record);
});

test('createAuditRecord defaults decided_by to unknown and note to null', () => {
  const record = createAuditRecord({
    proposal,
    decision: 'reject',
    now: FIXED_NOW,
    suffix: 'suffix-b',
  });

  assert.equal(record.decided_by, 'unknown');
  assert.equal(record.note, null);
  assert.equal(record.confidence_at_decision, proposal.confidence);
});

test('createAuditRecord rejects invalid decisions and proposals', () => {
  assert.throws(
    () => createAuditRecord({ proposal, decision: 'maybe' }),
    /decision/,
  );
  assert.throws(
    () => createAuditRecord({ proposal: null, decision: 'approve' }),
    /proposal/,
  );
});
