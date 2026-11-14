/**
 * Sentinel remediation proposal builder.
 *
 * Pure and deterministic: no Forge imports, no network calls, and no writes.
 * A proposal is a human-executed recommendation, never an automated action.
 */
import { assertKeyFitsStorage } from './ledger.js';
import { BLAST_RADIUS } from './fixtures.js';

export const PROPOSAL_KEY_PREFIX = 'sentinel:proposal:';
export const MIN_CONFIDENCE = 0.5;

/**
 * Builds the storage key for a proposal ID.
 *
 * @param {string} proposalId
 * @returns {string}
 */
export function proposalKey(proposalId) {
  if (typeof proposalId !== 'string' || proposalId.trim().length === 0) {
    throw new TypeError('proposalId must be a non-empty string.');
  }
  return assertKeyFitsStorage(`${PROPOSAL_KEY_PREFIX}${proposalId}`);
}

/**
 * Extracts the proposal ID from a storage key.
 *
 * @param {string} key
 * @returns {string}
 */
export function proposalIdFromKey(key) {
  assertKeyFitsStorage(key);
  if (!key.startsWith(PROPOSAL_KEY_PREFIX)) {
    throw new TypeError(`Storage key "${key}" is not a Sentinel proposal key.`);
  }
  return key.slice(PROPOSAL_KEY_PREFIX.length);
}

function sanitizeId(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'unknown';
  }
  return value.trim().replace(/[^A-Za-z0-9._-]/g, '-');
}

function confidenceOf(hypothesis) {
  const value = hypothesis && hypothesis.confidence;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function citationsOf(hypothesis) {
  return hypothesis && Array.isArray(hypothesis.citations)
    ? hypothesis.citations
    : [];
}

function factsByIdMap(facts) {
  const map = new Map();
  if (Array.isArray(facts)) {
    for (const fact of facts) {
      if (fact && typeof fact.fact_id === 'string') {
        map.set(fact.fact_id, fact);
      }
    }
  }
  return map;
}

function isSupportingCausal(citation) {
  return citation && citation.stance === 'supports' && citation.role === 'causal';
}

function firstService(fact) {
  if (fact && Array.isArray(fact.service_scope) && fact.service_scope.length > 0) {
    const first = fact.service_scope[0];
    if (typeof first === 'string' && first.trim().length > 0) {
      return first.trim();
    }
  }
  return null;
}

function actionFor(hypothesis, factsById) {
  const deploy = citationsOf(hypothesis)
    .filter(isSupportingCausal)
    .map((citation) => factsById.get(citation.fact_id))
    .find((fact) => fact && fact.fact_type === 'deploy');

  return deploy ? 'rollback' : 'restart';
}

function targetFor(hypothesis, factsById) {
  const causalFacts = citationsOf(hypothesis)
    .filter(isSupportingCausal)
    .map((citation) => factsById.get(citation.fact_id))
    .filter(Boolean);

  for (const fact of causalFacts) {
    if (fact.fact_type === 'deploy') {
      const service = firstService(fact);
      if (service) {
        return service;
      }
    }
  }

  for (const fact of causalFacts) {
    const service = firstService(fact);
    if (service) {
      return service;
    }
  }

  // Fallback for callers that do not pass facts: read the summary.
  const summary =
    hypothesis && typeof hypothesis.summary === 'string' ? hypothesis.summary : '';
  const match = summary.match(/([A-Za-z0-9-]+-service)/);
  return match ? match[1] : 'unknown';
}

function blastRadiusFor(target, blastRadius) {
  const table = blastRadius && typeof blastRadius === 'object' ? blastRadius : BLAST_RADIUS;
  const targetEntry = table[target];
  if (!targetEntry) {
    return [];
  }

  const rows = [targetEntry];
  const dependents = Array.isArray(targetEntry.dependents) ? targetEntry.dependents : [];
  for (const dependent of dependents) {
    const entry = table[dependent];
    if (entry && !rows.some((row) => row.service === entry.service)) {
      rows.push(entry);
    }
  }

  return rows.map((row) => ({
    service: row.service,
    owner: row.owner,
    dependents: Array.isArray(row.dependents) ? [...row.dependents] : [],
  }));
}

function instructionsFor(action, target, hypothesis) {
  const summary =
    hypothesis && typeof hypothesis.summary === 'string' ? hypothesis.summary : '';

  if (action === 'rollback') {
    return [
      `Human-executed rollback instructions for ${target}:`,
      '1. Confirm the incident is still active and the change window is approved.',
      `2. Roll back ${target} to the previous known-good version.`,
      '3. Disable the offending change (for example, a synchronous tax calculation) in the request path.',
      '4. Verify checkout latency and error rate return to baseline.',
      '5. Record the outcome in the audit log.',
      '',
      'This app does not perform the rollback. A human must execute these steps.',
      `Hypothesis: ${summary}`,
    ].join('\n');
  }

  return [
    `Human-executed restart instructions for ${target}:`,
    '1. Confirm the incident is still active and the restart is approved.',
    `2. Restart ${target} pods/instances one at a time.`,
    '3. Watch checkout latency and error rate during the restart.',
    '4. Escalate if the service does not return to baseline.',
    '5. Record the outcome in the audit log.',
    '',
    'This app does not perform the restart. A human must execute these steps.',
    `Hypothesis: ${summary}`,
  ].join('\n');
}

function diffFor(action, target, hypothesis) {
  const summary =
    hypothesis && typeof hypothesis.summary === 'string' ? hypothesis.summary : '';

  if (action === 'rollback') {
    return [
      `Rollback diff (text; human-executed) for ${target}:`,
      '- Revert the change that introduced the suspected root cause.',
      '- Restore the previous known-good configuration.',
      '- Keep the change disabled until the incident is resolved.',
      '',
      `Source hypothesis: ${summary}`,
    ].join('\n');
  }

  return [
    `Restart diff (text; human-executed) for ${target}:`,
    '- Restart the service instances without changing configuration.',
    '- Preserve logs and metrics for the incident review.',
    '',
    `Source hypothesis: ${summary}`,
  ].join('\n');
}

/**
 * Builds a remediation proposal for a single hypothesis.
 *
 * The hypothesis must already be the top-ranked candidate and have a confidence
 * of at least 0.5. When it does not qualify, the result is
 * `{ proposal: null, reason: "insufficient evidence" }`.
 *
 * @param {object} hypothesis
 * @param {object} [options]
 * @param {object[]} [options.facts] - Full ledger, used to derive the target.
 * @param {object} [options.blastRadius] - Seeded blast-radius table.
 * @param {number} [options.now] - Epoch milliseconds for deterministic IDs.
 * @returns {{proposal: object|null, reason?: string}}
 */
export function buildProposal(hypothesis, options = {}) {
  const { facts = [], blastRadius = BLAST_RADIUS, now = Date.now() } = options;

  if (!hypothesis || typeof hypothesis !== 'object' || Array.isArray(hypothesis)) {
    return { proposal: null, reason: 'insufficient evidence' };
  }

  const confidence = confidenceOf(hypothesis);
  if (confidence < MIN_CONFIDENCE) {
    return { proposal: null, reason: 'insufficient evidence' };
  }

  const factsById = factsByIdMap(facts);
  const citations = citationsOf(hypothesis);
  const evidenceFactIds = Array.from(
    new Set(
      citations
        .map((citation) =>
          citation && typeof citation.fact_id === 'string' ? citation.fact_id : null,
        )
        .filter((id) => id !== null),
    ),
  );

  const action = actionFor(hypothesis, factsById);
  const target = targetFor(hypothesis, factsById);
  const safeHypothesisId = sanitizeId(hypothesis.hypothesis_id).slice(0, 60);
  const proposalId = `proposal_${safeHypothesisId}_${new Date(now)
    .toISOString()
    .replace(/[:.]/g, '-')}`;

  const proposal = {
    proposal_id: proposalId,
    hypothesis_id:
      typeof hypothesis.hypothesis_id === 'string'
        ? hypothesis.hypothesis_id
        : 'unknown',
    action,
    target,
    rationale: `Top-ranked hypothesis ${
      hypothesis.hypothesis_id ?? 'unknown'
    } has confidence ${confidence.toFixed(2)}. Proposed ${action} for ${target}.`,
    evidence_fact_ids: evidenceFactIds,
    blast_radius: blastRadiusFor(target, blastRadius),
    instructions: instructionsFor(action, target, hypothesis),
    diff: diffFor(action, target, hypothesis),
    confidence,
    created_at: new Date(now).toISOString(),
  };

  return { proposal };
}

/**
 * Builds a proposal for the top-ranked hypothesis in a ranked list.
 *
 * @param {object[]} hypotheses
 * @param {object} [options]
 * @returns {{proposal: object|null, reason?: string}}
 */
export function buildTopProposal(hypotheses, options = {}) {
  if (!Array.isArray(hypotheses) || hypotheses.length === 0) {
    return { proposal: null, reason: 'insufficient evidence' };
  }

  const top = hypotheses.find((hypothesis) => hypothesis && hypothesis.rank === 1) ||
    hypotheses[0];
  return buildProposal(top, options);
}
