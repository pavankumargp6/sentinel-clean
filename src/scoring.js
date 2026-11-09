/**
 * Sentinel scoring: pure, deterministic functions for the Causal Inversion
 * Guard and hypothesis confidence.
 *
 * This file has no Forge imports so it can be unit-tested with plain Node.
 *
 * @typedef {import('./ledger.js').Fact} Fact
 *
 * @typedef {object} Citation
 * @property {string} fact_id
 * @property {'supports'|'contradicts'} stance
 *
 * @typedef {object} Hypothesis
 * @property {string} summary
 * @property {Citation[]} citations
 *
 * @typedef {object} ConfidenceResult
 * @property {number} confidence
 * @property {boolean} insufficient_evidence
 * @property {Citation[]} valid_citations
 * @property {Citation[]} rejected_citations
 */

const SUPPORTS = 'supports';
const CONTRADICTS = 'contradicts';
const INSUFFICIENT_EVIDENCE_THRESHOLD = 0.2;

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
  return typeof fact.weight === 'number' && Number.isFinite(fact.weight)
    ? fact.weight
    : 0;
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
 * Sums only the maximum weight per cluster.
 *
 * Multiple facts from one cluster usually describe the same underlying event
 * (for example, a deploy and its change ticket). Taking the maximum prevents
 * that event from being counted twice.
 */
function sumClusterMaxima(entries) {
  const maxByCluster = new Map();

  for (const { fact, weight } of entries) {
    const cluster = clusterKey(fact);
    const current = maxByCluster.get(cluster);

    if (current === undefined || weight > current) {
      maxByCluster.set(cluster, weight);
    }
  }

  let total = 0;
  for (const weight of maxByCluster.values()) {
    total += weight;
  }
  return total;
}

/**
 * Scores one hypothesis against the full ledger.
 *
 * Citations whose fact_id is absent from allFacts are rejected before scoring,
 * which is the hallucination guard. Valid citations are split by stance and
 * deduplicated per cluster by taking only the maximum weight in each cluster.
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

  const citations = Array.isArray(hypothesis.citations)
    ? hypothesis.citations
    : [];
  const validCitations = [];
  const rejectedCitations = [];
  const supportEntries = [];
  const contradictEntries = [];

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

    validCitations.push(citation);
    const entry = { fact, weight: factWeight(fact) };

    if (citation.stance === SUPPORTS) {
      supportEntries.push(entry);
    } else if (citation.stance === CONTRADICTS) {
      contradictEntries.push(entry);
    }
  }

  const totalSupportWeight = sumClusterMaxima(supportEntries);
  const totalContradictWeight = sumClusterMaxima(contradictEntries);
  const confidence = Math.min(
    1,
    Math.max(0, totalSupportWeight - totalContradictWeight),
  );

  return {
    confidence,
    insufficient_evidence:
      totalSupportWeight < INSUFFICIENT_EVIDENCE_THRESHOLD,
    valid_citations: validCitations,
    rejected_citations: rejectedCitations,
  };
}
