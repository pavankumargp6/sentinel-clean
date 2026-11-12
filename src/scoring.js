/**
 * Sentinel scoring: pure, deterministic functions for the Causal Inversion
 * Guard, hypothesis confidence, and ranking.
 *
 * This file has no Forge imports so it can be unit-tested with plain Node.
 *
 * @typedef {import('./ledger.js').Fact} Fact
 *
 * @typedef {object} Citation
 * @property {string} hypothesis_id
 * @property {string} fact_id
 * @property {'supports'|'contradicts'} stance
 *
 * @typedef {object} ScoredCitation
 * @property {string} hypothesis_id
 * @property {string} fact_id
 * @property {'supports'|'contradicts'} stance
 * @property {'causal'|'context'} role
 *
 * @typedef {object} Hypothesis
 * @property {string} hypothesis_id
 * @property {string} summary
 * @property {Citation[]} citations
 *
 * @typedef {object} ConfidenceResult
 * @property {number} confidence
 * @property {boolean} insufficient_evidence
 * @property {number} corroboration
 * @property {number} causal_cluster_count
 * @property {ScoredCitation[]} valid_citations
 * @property {Citation[]} rejected_citations
 * @property {Citation[]} blocked_citations
 */

const SUPPORTS = 'supports';
const CONTRADICTS = 'contradicts';
const INSUFFICIENT_EVIDENCE_THRESHOLD = 0.2;

/**
 * Fact types that describe the incident symptom or response context.
 *
 * They remain valid citations so the UI can show what the hypothesis was
 * reasoning about, but they contribute no causal support or contradiction.
 * Keep this list explicit and small; expand it only with a deliberate scoring
 * change.
 */
export const NON_CAUSAL_FACT_TYPES = Object.freeze(['alert']);

function isNonCausal(fact) {
  return NON_CAUSAL_FACT_TYPES.includes(fact.fact_type);
}

function isRemediationAction(fact) {
  return fact.fact_type === 'remediation_action';
}

/**
 * Removes facts that must never be presented as a cause.
 *
 * A remediation action is a response to an incident, not evidence of what
 * caused it. Filtering it at the generation boundary keeps the model from
 * proposing "we restarted the service" as the root cause.
 *
 * @param {Fact[]} facts
 * @returns {Fact[]} A new array without remediation_action facts.
 */
export function applyCausalInversionGuard(facts) {
  if (!Array.isArray(facts)) {
    throw new TypeError('applyCausalInversionGuard expects an array of facts.');
  }

  return facts.filter((fact) => fact?.fact_type !== 'remediation_action');
}

function factWeight(fact) {
  if (typeof fact.weight !== 'number' || !Number.isFinite(fact.weight)) {
    return 0;
  }

  return Math.min(1, Math.max(0, fact.weight));
}

function clusterKey(fact) {
  if (typeof fact.cluster === 'string' && fact.cluster.trim().length > 0) {
    return fact.cluster.trim();
  }

  // A malformed or missing cluster must not merge unrelated facts into one
  // group and accidentally suppress a valid weight.
  return `__fact__:${fact.fact_id}`;
}

/**
 * Returns the best weight per evidence cluster.
 *
 * Multiple facts from one cluster usually describe the same underlying signal
 * (for example, a deploy and its change ticket). Taking the maximum prevents
 * that signal from being counted twice.
 *
 * @param {{fact: Fact, weight: number}[]} entries
 * @returns {Map<string, number>}
 */
function bestWeightByCluster(entries) {
  const maxByCluster = new Map();

  for (const { fact, weight } of entries) {
    const cluster = clusterKey(fact);
    const current = maxByCluster.get(cluster);

    if (current === undefined || weight > current) {
      maxByCluster.set(cluster, weight);
    }
  }

  return maxByCluster;
}

/**
 * Combines independent cluster weights with noisy-OR:
 * 1 - product(1 - weight).
 *
 * This approaches 1 asymptotically but never reaches it from finite,
 * sub-1.0 weights, so two strong clusters do not automatically saturate.
 *
 * @param {Map<string, number>} maxByCluster
 * @returns {number}
 */
function noisyOr(maxByCluster) {
  let product = 1;

  for (const weight of maxByCluster.values()) {
    product *= 1 - weight;
  }

  return 1 - product;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function supportingSourceSystem(fact) {
  return typeof fact.source_system === 'string' && fact.source_system.trim().length > 0
    ? fact.source_system.trim()
    : null;
}

/**
 * Scores one hypothesis against the full ledger.
 *
 * Unknown fact IDs are rejected before scoring, which prevents the model from
 * inventing evidence. Citations to remediation_action facts are blocked by the
 * Causal Inversion Guard and never count as root-cause support or contradiction.
 *
 * Non-causal facts (currently alerts) remain valid citations with role
 * "context", but contribute no support/contradiction weight and do not count
 * toward corroboration.
 *
 * Valid causal citations are split by stance and deduplicated per cluster by
 * taking only the maximum weight in each cluster. Support and contradiction are
 * each combined with noisy-OR across clusters, then confidence is
 * support * (1 - contradiction), clamped to [0, 1].
 *
 * Corroboration is the count of distinct source_system values among valid
 * causal supporting citations; it is reported for display and is never used as
 * a multiplier. causal_cluster_count is the number of distinct clusters among
 * those supporting causal citations.
 *
 * A citation with a stance other than "supports" or "contradicts" remains a
 * valid citation but contributes no weight.
 *
 * @param {Hypothesis} hypothesis
 * @param {Fact[]} allFacts
 * @returns {ConfidenceResult}
 */
export function calculateConfidence(hypothesis, allFacts) {
  if (!hypothesis || typeof hypothesis !== 'object' || Array.isArray(hypothesis)) {
    throw new TypeError('calculateConfidence expects a hypothesis object.');
  }
  if (!Array.isArray(allFacts)) {
    throw new TypeError('calculateConfidence expects an array of facts.');
  }

  const factsById = new Map();
  for (const fact of allFacts) {
    if (fact && typeof fact.fact_id === 'string') {
      factsById.set(fact.fact_id, fact);
    }
  }

  const hypothesisId =
    typeof hypothesis.hypothesis_id === 'string'
      ? hypothesis.hypothesis_id
      : '';
  const citations = Array.isArray(hypothesis.citations)
    ? hypothesis.citations
    : [];
  const validCitations = [];
  const rejectedCitations = [];
  const blockedCitations = [];
  const supportEntries = [];
  const contradictEntries = [];
  const supportingSources = new Set();

  for (const citation of citations) {
    if (!citation || typeof citation !== 'object' || Array.isArray(citation)) {
      rejectedCitations.push(citation);
      continue;
    }

    const fact =
      typeof citation.fact_id === 'string'
        ? factsById.get(citation.fact_id)
        : undefined;

    if (!fact) {
      rejectedCitations.push(citation);
      continue;
    }

    if (isRemediationAction(fact)) {
      blockedCitations.push(citation);
      continue;
    }

    const role = isNonCausal(fact) ? 'context' : 'causal';
    validCitations.push({
      hypothesis_id: hypothesisId,
      fact_id: citation.fact_id,
      stance: citation.stance,
      role,
    });

    if (role === 'context') {
      continue;
    }

    const entry = { fact, weight: factWeight(fact) };

    if (citation.stance === SUPPORTS) {
      supportEntries.push(entry);
      const source = supportingSourceSystem(fact);
      if (source !== null) {
        supportingSources.add(source);
      }
    } else if (citation.stance === CONTRADICTS) {
      contradictEntries.push(entry);
    }
  }

  const supportByCluster = bestWeightByCluster(supportEntries);
  const contradictByCluster = bestWeightByCluster(contradictEntries);
  const support = noisyOr(supportByCluster);
  const contradiction = noisyOr(contradictByCluster);
  const confidence =
    validCitations.length === 0
      ? 0
      : clamp01(support * (1 - contradiction));

  return {
    confidence,
    insufficient_evidence: support < INSUFFICIENT_EVIDENCE_THRESHOLD,
    corroboration: supportingSources.size,
    causal_cluster_count: supportByCluster.size,
    valid_citations: validCitations,
    rejected_citations: rejectedCitations,
    blocked_citations: blockedCitations,
  };
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Ranks scored hypotheses deterministically.
 *
 * Order: confidence descending, then corroboration descending, then number of
 * supporting causal clusters descending. Ties beyond that keep the input order
 * (Array.prototype.sort is stable in supported Node versions).
 *
 * @param {object[]} hypotheses - Scored hypotheses with confidence,
 *   corroboration, and causal_cluster_count fields.
 * @returns {object[]} New objects sorted and annotated with a 1-based rank.
 */
export function rankHypotheses(hypotheses) {
  if (!Array.isArray(hypotheses)) {
    throw new TypeError('rankHypotheses expects an array of hypotheses.');
  }

  return hypotheses
    .map((hypothesis) => ({ ...hypothesis }))
    .sort(
      (left, right) =>
        numberOrZero(right.confidence) - numberOrZero(left.confidence) ||
        numberOrZero(right.corroboration) - numberOrZero(left.corroboration) ||
        numberOrZero(right.causal_cluster_count) -
          numberOrZero(left.causal_cluster_count),
    )
    .map((hypothesis, index) => ({
      ...hypothesis,
      rank: index + 1,
    }));
}
