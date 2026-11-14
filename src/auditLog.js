/**
 * Sentinel audit log: pure helpers for append-only decision records.
 *
 * This module has no Forge imports so key helpers and record shape can be
 * unit-tested with plain Node. Storage itself lives in src/index.js.
 */
import { assertKeyFitsStorage } from './ledger.js';

export const AUDIT_KEY_PREFIX = 'sentinel:audit:';
export const AUDIT_INDEX_KEY = 'sentinel:audit:index';
export const AUDIT_INDEX_VERSION = 1;
export const DECISIONS = Object.freeze(['approve', 'reject']);

/**
 * Builds the storage key for an audit record.
 *
 * @param {string} auditId
 * @returns {string}
 */
export function auditKey(auditId) {
  if (typeof auditId !== 'string' || auditId.trim().length === 0) {
    throw new TypeError('auditId must be a non-empty string.');
  }
  return assertKeyFitsStorage(`${AUDIT_KEY_PREFIX}${auditId}`);
}

/**
 * Extracts the audit ID from a storage key.
 *
 * @param {string} key
 * @returns {string}
 */
export function auditIdFromKey(key) {
  assertKeyFitsStorage(key);
  if (!key.startsWith(AUDIT_KEY_PREFIX)) {
    throw new TypeError(`Storage key "${key}" is not a Sentinel audit key.`);
  }
  return key.slice(AUDIT_KEY_PREFIX.length);
}

/**
 * Builds a deterministic audit ID with a timestamp suffix.
 *
 * The caller supplies a suffix (for example, a random component plus a retry
 * counter) so the same timestamp can still produce unique keys.
 *
 * @param {number} [now] - Epoch milliseconds.
 * @param {string} [suffix]
 * @returns {string}
 */
export function buildAuditId(now = Date.now(), suffix = '') {
  const iso = new Date(now).toISOString().replace(/[:.]/g, '-');
  const safeSuffix =
    typeof suffix === 'string' && suffix.trim().length > 0
      ? suffix.trim().replace(/[^A-Za-z0-9._-]/g, '-')
      : '0';
  return `audit_${iso}_${safeSuffix}`;
}

/**
 * Builds one append-only audit record.
 *
 * @param {object} params
 * @param {object} params.proposal
 * @param {object|null} [params.topHypothesis]
 * @param {'approve'|'reject'} params.decision
 * @param {string} [params.note]
 * @param {string} [params.decidedBy] - Resolver account ID, or "unknown".
 * @param {number} [params.now]
 * @param {string} [params.suffix]
 * @returns {object}
 */
export function createAuditRecord({
  proposal,
  topHypothesis = null,
  decision,
  note = null,
  decidedBy = 'unknown',
  now = Date.now(),
  suffix = '',
}) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new TypeError('createAuditRecord expects a proposal object.');
  }
  if (typeof proposal.proposal_id !== 'string' || proposal.proposal_id.length === 0) {
    throw new TypeError('createAuditRecord expects proposal.proposal_id.');
  }
  if (
    typeof proposal.hypothesis_id !== 'string' ||
    proposal.hypothesis_id.length === 0
  ) {
    throw new TypeError('createAuditRecord expects proposal.hypothesis_id.');
  }
  if (!DECISIONS.includes(decision)) {
    throw new TypeError(
      `createAuditRecord decision must be one of ${DECISIONS.join(', ')}.`,
    );
  }

  const confidence =
    topHypothesis &&
    typeof topHypothesis.confidence === 'number' &&
    Number.isFinite(topHypothesis.confidence)
      ? topHypothesis.confidence
      : typeof proposal.confidence === 'number' &&
          Number.isFinite(proposal.confidence)
        ? proposal.confidence
        : 0;

  const evidenceFactIds = Array.isArray(proposal.evidence_fact_ids)
    ? proposal.evidence_fact_ids.filter((id) => typeof id === 'string')
    : [];

  return {
    audit_id: buildAuditId(now, suffix),
    proposal_id: proposal.proposal_id,
    hypothesis_id: proposal.hypothesis_id,
    decision,
    decided_at: new Date(now).toISOString(),
    decided_by:
      typeof decidedBy === 'string' && decidedBy.trim().length > 0
        ? decidedBy.trim()
        : 'unknown',
    evidence_fact_ids: Array.from(new Set(evidenceFactIds)),
    confidence_at_decision: confidence,
    note:
      typeof note === 'string' && note.trim().length > 0 ? note.trim() : null,
  };
}

/**
 * Validates an audit record without changing it.
 *
 * @param {object} record
 * @returns {object}
 */
export function validateAuditRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('Invalid audit record: expected an object.');
  }
  if (typeof record.audit_id !== 'string' || record.audit_id.length === 0) {
    throw new TypeError('Invalid audit record.audit_id.');
  }
  if (typeof record.proposal_id !== 'string' || record.proposal_id.length === 0) {
    throw new TypeError('Invalid audit record.proposal_id.');
  }
  if (
    typeof record.hypothesis_id !== 'string' ||
    record.hypothesis_id.length === 0
  ) {
    throw new TypeError('Invalid audit record.hypothesis_id.');
  }
  if (!DECISIONS.includes(record.decision)) {
    throw new TypeError('Invalid audit record.decision.');
  }
  if (
    typeof record.decided_at !== 'string' ||
    Number.isNaN(new Date(record.decided_at).getTime())
  ) {
    throw new TypeError('Invalid audit record.decided_at.');
  }
  if (typeof record.decided_by !== 'string' || record.decided_by.length === 0) {
    throw new TypeError('Invalid audit record.decided_by.');
  }
  if (!Array.isArray(record.evidence_fact_ids)) {
    throw new TypeError('Invalid audit record.evidence_fact_ids.');
  }
  if (
    typeof record.confidence_at_decision !== 'number' ||
    !Number.isFinite(record.confidence_at_decision)
  ) {
    throw new TypeError('Invalid audit record.confidence_at_decision.');
  }
  return record;
}
