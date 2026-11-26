/**
 * Sentinel last-run store: one scored run, one source of truth for proposals.
 *
 * This module is pure. The resolver writes the returned object to one KVS key,
 * and getProposal reads it instead of calling the model again. That prevents
 * the approval card from disagreeing with the hypothesis table the user just
 * saw.
 *
 * No Forge imports here so the shape and proposal handoff can be tested with
 * plain Node.
 */
import { buildTopProposal } from './remediation.js';

export const LAST_RUN_KEY = 'sentinel:last_run';
export const LAST_RUN_VERSION = 1;
export const LAST_PROPOSAL_KEY = 'sentinel:last_proposal';
export const LAST_PROPOSAL_VERSION = 1;
export const RUN_SOURCES = Object.freeze(['llm', 'mock']);

/**
 * Builds the pointer to the latest stored proposal.
 *
 * The proposal body stays under its own key. This pointer only says which
 * proposal belongs to the stored run, so getPostmortem can read the same
 * proposal that recordDecision audited without scanning proposal keys.
 *
 * @param {object} params
 * @param {string} params.proposalId
 * @param {string} [params.createdAt]
 * @returns {object}
 */
export function createProposalPointer({
  proposalId,
  createdAt = new Date().toISOString(),
} = {}) {
  if (typeof proposalId !== 'string' || proposalId.trim().length === 0) {
    throw new TypeError('createProposalPointer expects a non-empty proposalId.');
  }
  if (typeof createdAt !== 'string' || createdAt.trim().length === 0) {
    throw new TypeError('createProposalPointer expects a non-empty createdAt.');
  }

  return {
    version: LAST_PROPOSAL_VERSION,
    proposal_id: proposalId.trim(),
    created_at: createdAt.trim(),
  };
}

/**
 * Validates a proposal pointer read from KVS.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isProposalPointer(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      value.version === LAST_PROPOSAL_VERSION &&
      typeof value.proposal_id === 'string' &&
      value.proposal_id.length > 0 &&
      typeof value.created_at === 'string' &&
      value.created_at.length > 0,
  );
}

/**
 * Builds the stored run object.
 *
 * @param {object} params
 * @param {object[]} params.hypotheses - Scored, ranked hypotheses.
 * @param {'llm'|'mock'} params.source
 * @param {string} params.model
 * @param {boolean} [params.fallback_used]
 * @param {string|null} [params.fallback_reason]
 * @param {string} [params.created_at]
 * @returns {object}
 */
export function createStoredRun({
  hypotheses,
  source,
  model,
  fallback_used = false,
  fallback_reason = null,
  created_at = new Date().toISOString(),
} = {}) {
  if (!Array.isArray(hypotheses) || hypotheses.length === 0) {
    throw new TypeError(
      'createStoredRun expects a non-empty array of hypotheses.',
    );
  }
  if (!RUN_SOURCES.includes(source)) {
    throw new TypeError(
      `createStoredRun source must be one of ${RUN_SOURCES.join(', ')}.`,
    );
  }
  if (typeof model !== 'string' || model.trim().length === 0) {
    throw new TypeError('createStoredRun expects a non-empty model string.');
  }

  return {
    version: LAST_RUN_VERSION,
    created_at,
    source,
    model: model.trim(),
    fallback_used: Boolean(fallback_used),
    fallback_reason:
      typeof fallback_reason === 'string' && fallback_reason.trim().length > 0
        ? fallback_reason.trim()
        : null,
    hypotheses,
    count: hypotheses.length,
  };
}

/**
 * Validates a value read from KVS before it is used as a scored run.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isStoredRun(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      value.version === LAST_RUN_VERSION &&
      typeof value.created_at === 'string' &&
      value.created_at.length > 0 &&
      RUN_SOURCES.includes(value.source) &&
      typeof value.model === 'string' &&
      value.model.length > 0 &&
      Array.isArray(value.hypotheses) &&
      value.hypotheses.length > 0,
  );
}

/**
 * Builds the proposal from the stored run's ranked hypotheses.
 *
 * This is the only proposal path used by getProposal. It never calls the model
 * and never re-ranks; it uses the ranks saved by generateHypotheses.
 *
 * @param {object} run
 * @param {object} [options] - Passed through to buildTopProposal (facts, now).
 * @returns {{proposal: object|null, reason: string|null, top_hypothesis: object|null}}
 */
export function proposalFromStoredRun(run, options = {}) {
  if (!isStoredRun(run)) {
    return {
      proposal: null,
      reason: 'Run the Hypothesis Engine first to score hypotheses.',
      top_hypothesis: null,
    };
  }

  const topHypothesis =
    run.hypotheses.find(
      (hypothesis) => hypothesis && hypothesis.rank === 1,
    ) ||
    run.hypotheses[0] ||
    null;
  const result = buildTopProposal(run.hypotheses, options);

  return {
    proposal: result.proposal ?? null,
    reason: result.reason ?? null,
    top_hypothesis: topHypothesis,
  };
}
