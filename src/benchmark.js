/**
 * Sentinel benchmark harness.
 *
 * Pure orchestration: the caller injects a generator. Tests pass a stubbed
 * generator; the resolver passes a wrapper around the Forge LLM. This module
 * has no Forge imports and never touches KVS, the stored run, proposals, or the
 * audit log. Benchmark results are synthetic and must not be presented as real
 * incident outcomes.
 *
 * Evaluation rules:
 * - A cause scenario passes when the rank-1 hypothesis has a valid causal
 *   supporting citation to one of the ground-truth cause fact IDs.
 * - Top-3 correctness uses the same rule against the first three hypotheses.
 * - An abstain scenario passes when no hypothesis clears the same 0.5
 *   confidence threshold used by the proposal builder.
 * - A scenario produced by the deterministic mock fallback is marked
 *   `evaluated: false` and excluded from every accuracy denominator. Its
 *   predictions remain visible for transparency, but it can never count as a
 *   pass or a failure. Only real LLM output is evaluated.
 * - Generator errors are evaluated failures, not valid abstentions.
 * - Citations to nonexistent facts and citations to remediation actions are
 *   blocked by the deterministic scorer and counted separately. They can never
 *   contribute to a correct answer. A remediation-blocked count of zero only
 *   means the model did not cite the bait in that run; the unit tests prove
 *   separately that a cited remediation fact is blocked and counted.
 */
import {
  calculateConfidence,
  rankHypotheses,
} from './scoring.js';

export const BENCHMARK_LABEL = 'synthetic scenarios authored by the developer';
export const BENCHMARK_VERSION = 1;

// Keep in sync with remediation.MIN_CONFIDENCE. The value is duplicated here
// so the browser bundle does not pull the seeded fixture table through
// remediation.js just to read one threshold.
export const BENCHMARK_ABSTAIN_THRESHOLD = 0.5;
const MIN_CONFIDENCE = BENCHMARK_ABSTAIN_THRESHOLD;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(values) {
  return Array.from(
    new Set(values.filter((value) => typeof value === 'string' && value.length > 0)),
  );
}

function citationIds(citations) {
  return uniqueStrings(
    citations
      .map((citation) =>
        isObject(citation) && typeof citation.fact_id === 'string'
          ? citation.fact_id
          : null,
      )
      .filter((id) => id !== null),
  );
}

function isSupportingCausal(citation) {
  return (
    isObject(citation) &&
    citation.stance === 'supports' &&
    citation.role === 'causal' &&
    typeof citation.fact_id === 'string'
  );
}

const NOT_EVALUATED_REASON =
  'Deterministic mock fallback used; this scenario was excluded from accuracy.';

/**
 * Normalizes the two generator return shapes into one internal shape.
 *
 * A raw array is treated as real LLM output because only the live wrapper
 * returns the richer object. Tests and other callers can simulate a mock
 * fallback by returning `{ hypotheses, source: 'mock' }` or by setting
 * `fallback_used: true`.
 *
 * @param {object[]|{hypotheses: object[], source?: string, fallback_used?: boolean, fallback_reason?: string}} generated
 * @returns {{hypotheses: object[], source: 'llm'|'mock', source_label: string, fallback_reason: string|null}}
 */
function normalizeGeneratorResult(generated) {
  if (Array.isArray(generated)) {
    return {
      hypotheses: generated,
      source: 'llm',
      source_label: 'LLM',
      fallback_reason: null,
    };
  }

  if (!isObject(generated) || !Array.isArray(generated.hypotheses)) {
    throw new Error('Benchmark generator returned no hypotheses array.');
  }

  const usedMock =
    generated.fallback_used === true || generated.source === 'mock';
  const source = usedMock ? 'mock' : 'llm';
  const fallbackReason =
    typeof generated.fallback_reason === 'string' &&
    generated.fallback_reason.length > 0
      ? generated.fallback_reason
      : null;

  return {
    hypotheses: generated.hypotheses,
    source,
    source_label: source === 'mock' ? 'Mock fallback' : 'LLM',
    fallback_reason: fallbackReason,
  };
}

/**
 * Validates one benchmark scenario and normalizes its ground truth.
 *
 * Programmer errors (a malformed scenario) throw and stop the whole run before
 * any generator is called. Generator errors are handled per scenario instead,
 * so one bad model response does not discard the other results.
 *
 * @param {object} scenario
 * @returns {{abstain: boolean, cause_fact_ids: string[]}}
 */
export function validateBenchmarkScenario(scenario) {
  if (!isObject(scenario)) {
    throw new TypeError('Benchmark scenario must be an object.');
  }
  if (typeof scenario.id !== 'string' || scenario.id.trim().length === 0) {
    throw new TypeError('Benchmark scenario.id must be a non-empty string.');
  }
  if (!Array.isArray(scenario.facts) || scenario.facts.length === 0) {
    throw new TypeError(
      `Benchmark scenario "${scenario.id}" must contain at least one fact.`,
    );
  }
  for (const fact of scenario.facts) {
    if (!isObject(fact) || typeof fact.fact_id !== 'string' || fact.fact_id.length === 0) {
      throw new TypeError(
        `Benchmark scenario "${scenario.id}" contains a fact without a valid fact_id.`,
      );
    }
  }

  const groundTruth = scenario.ground_truth;
  if (!isObject(groundTruth)) {
    throw new TypeError(
      `Benchmark scenario "${scenario.id}" must contain ground_truth.`,
    );
  }

  const abstain = groundTruth.abstain === true;
  const causeFactIds = Array.isArray(groundTruth.cause_fact_ids)
    ? uniqueStrings(groundTruth.cause_fact_ids)
    : [];

  if (abstain && causeFactIds.length > 0) {
    throw new TypeError(
      `Benchmark scenario "${scenario.id}" cannot both abstain and list cause facts.`,
    );
  }
  if (!abstain && causeFactIds.length === 0) {
    throw new TypeError(
      `Benchmark scenario "${scenario.id}" must list ground_truth.cause_fact_ids or set ground_truth.abstain.`,
    );
  }

  return { abstain, cause_fact_ids: causeFactIds };
}

/**
 * Scores raw generator output against one scenario's facts.
 *
 * This is the same scoring path used by the live hypothesis engine, so a
 * benchmark result reflects the product's real guardrails rather than a
 * benchmark-only shortcut.
 *
 * @param {object[]} rawHypotheses
 * @param {object[]} facts
 * @returns {object[]} Ranked scored hypotheses.
 */
export function scoreBenchmarkHypotheses(rawHypotheses, facts) {
  if (!Array.isArray(rawHypotheses)) {
    throw new TypeError('scoreBenchmarkHypotheses expects an array.');
  }
  if (!Array.isArray(facts)) {
    throw new TypeError('scoreBenchmarkHypotheses expects an array of facts.');
  }

  const usable = rawHypotheses.filter(
    (hypothesis) => isObject(hypothesis) && !Array.isArray(hypothesis),
  );
  if (usable.length === 0) {
    throw new Error('Benchmark generator returned no usable hypotheses.');
  }

  const scored = usable.map((hypothesis) => {
    const result = calculateConfidence(hypothesis, facts);
    return {
      hypothesis_id:
        typeof hypothesis.hypothesis_id === 'string'
          ? hypothesis.hypothesis_id
          : 'unknown',
      summary:
        typeof hypothesis.summary === 'string' ? hypothesis.summary : '',
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
      rejected_citation_count: result.rejected_citations.length,
      blocked_citation_count: result.blocked_citations.length,
    };
  });

  return rankHypotheses(scored);
}

function causeIdsInHypothesis(hypothesis, expectedIds) {
  if (!isObject(hypothesis) || !Array.isArray(hypothesis.citations)) {
    return [];
  }
  return uniqueStrings(
    hypothesis.citations
      .filter(isSupportingCausal)
      .map((citation) => citation.fact_id)
      .filter((factId) => expectedIds.has(factId)),
  );
}

function topHypothesesSummary(hypotheses) {
  return hypotheses.slice(0, 3).map((hypothesis) => ({
    hypothesis_id: hypothesis.hypothesis_id,
    summary: hypothesis.summary,
    confidence: hypothesis.confidence,
    citations: hypothesis.citations,
    rejected_citation_ids: hypothesis.rejected_citation_ids,
    blocked_citation_ids: hypothesis.blocked_citation_ids,
  }));
}

function evaluateScenario(scenario, meta, ranked, generator) {
  const top = ranked[0] || null;
  const expectedIds = new Set(meta.cause_fact_ids);
  const topConfidence =
    top && typeof top.confidence === 'number' ? top.confidence : null;
  const abstained = top === null || topConfidence < MIN_CONFIDENCE;
  const evaluated = generator.source !== 'mock';

  const topMatchIds =
    !meta.abstain && !abstained && top
      ? causeIdsInHypothesis(top, expectedIds)
      : [];
  const top1Correct = meta.abstain ? null : !abstained && topMatchIds.length > 0;
  const top3Correct = meta.abstain
    ? null
    : !abstained &&
      ranked
        .slice(0, 3)
        .some((hypothesis) => causeIdsInHypothesis(hypothesis, expectedIds).length > 0);

  const predictedIds =
    !meta.abstain && !abstained && top
      ? uniqueStrings(
          top.citations
            .filter(isSupportingCausal)
            .map((citation) => citation.fact_id),
        )
      : [];

  const passed = meta.abstain ? abstained : Boolean(top1Correct);
  const predictedLabel = abstained
    ? 'abstain'
    : predictedIds.length > 0
      ? predictedIds.join(', ')
      : 'no causal fact cited';

  return {
    scenario_id: scenario.id,
    expected_abstain: meta.abstain,
    expected_label: meta.abstain ? 'abstain' : meta.cause_fact_ids.join(', '),
    predicted_label: predictedLabel,
    predicted_hypothesis_id: top ? top.hypothesis_id : null,
    predicted_cause_fact_ids: predictedIds,
    confidence: topConfidence,
    abstained,
    source: generator.source,
    source_label: generator.source_label,
    evaluated,
    not_evaluated_reason: evaluated
      ? null
      : generator.fallback_reason
        ? `${NOT_EVALUATED_REASON} Reason: ${generator.fallback_reason}`
        : NOT_EVALUATED_REASON,
    // A mock fallback is not a product prediction, so it is neither a pass nor
    // a failure. Accuracy and pass counts use only evaluated results.
    passed: evaluated ? passed : null,
    top1_correct: evaluated ? top1Correct : null,
    top3_correct: evaluated ? top3Correct : null,
    error: null,
    hypothesis_count: ranked.length,
    top_hypotheses: topHypothesesSummary(ranked),
    hallucinated_citations_blocked: ranked.reduce(
      (total, hypothesis) => total + hypothesis.rejected_citation_count,
      0,
    ),
    remediation_citations_blocked: ranked.reduce(
      (total, hypothesis) => total + hypothesis.blocked_citation_count,
      0,
    ),
  };
}

function errorResult(scenario, meta, error) {
  return {
    scenario_id: scenario.id,
    expected_abstain: meta.abstain,
    expected_label: meta.abstain ? 'abstain' : meta.cause_fact_ids.join(', '),
    predicted_label: 'error',
    predicted_hypothesis_id: null,
    predicted_cause_fact_ids: [],
    confidence: null,
    // A generator failure is not a valid abstention and is not a mock
    // fallback. It is an attempted LLM result that is counted as a failure.
    abstained: false,
    source: 'llm',
    source_label: 'LLM',
    evaluated: true,
    not_evaluated_reason: null,
    passed: false,
    top1_correct: meta.abstain ? null : false,
    top3_correct: meta.abstain ? null : false,
    error: errorMessage(error),
    hypothesis_count: 0,
    top_hypotheses: [],
    hallucinated_citations_blocked: 0,
    remediation_citations_blocked: 0,
  };
}

async function runScenario(scenario, generate, meta) {
  try {
    const generated = await generate(scenario);
    const normalized = normalizeGeneratorResult(generated);
    const ranked = scoreBenchmarkHypotheses(
      normalized.hypotheses,
      scenario.facts,
    );
    return evaluateScenario(scenario, meta, ranked, normalized);
  } catch (error) {
    return errorResult(scenario, meta, error);
  }
}

/**
 * Aggregates per-scenario results into the benchmark metrics.
 *
 * This function is exported separately so the UI can merge results returned by
 * separate resolver invocations and recompute the same metrics locally.
 *
 * @param {object[]} results
 * @returns {object}
 */
export function summarizeBenchmarkResults(results) {
  const safeResults = Array.isArray(results)
    ? results.filter((result) => isObject(result))
    : [];
  // Older results without an explicit `evaluated` flag predate mock-fallback
  // support and were all real LLM results. Treat only `false` as excluded.
  const evaluatedResults = safeResults.filter(
    (result) => result.evaluated !== false,
  );
  const notEvaluatedResults = safeResults.filter(
    (result) => result.evaluated === false,
  );
  const causeResults = evaluatedResults.filter(
    (result) => !result.expected_abstain,
  );
  const abstainResults = evaluatedResults.filter(
    (result) => result.expected_abstain,
  );

  const top1CorrectCount = causeResults.filter(
    (result) => result.top1_correct === true,
  ).length;
  const top3CorrectCount = causeResults.filter(
    (result) => result.top3_correct === true,
  ).length;
  const abstentionCorrectCount = abstainResults.filter(
    (result) => result.passed === true,
  ).length;
  const passedCount = evaluatedResults.filter(
    (result) => result.passed === true,
  ).length;
  const errorCount = evaluatedResults.filter(
    (result) => typeof result.error === 'string' && result.error.length > 0,
  ).length;

  const sumCounts = (field) =>
    evaluatedResults.reduce((total, result) => {
      const value = result[field];
      return total + (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    }, 0);

  return {
    label: BENCHMARK_LABEL,
    scenario_count: safeResults.length,
    evaluated_scenario_count: evaluatedResults.length,
    not_evaluated_count: notEvaluatedResults.length,
    cause_scenario_count: causeResults.length,
    abstain_scenario_count: abstainResults.length,
    passed_count: passedCount,
    error_count: errorCount,
    top1_correct_count: top1CorrectCount,
    top3_correct_count: top3CorrectCount,
    abstention_correct_count: abstentionCorrectCount,
    top1_accuracy:
      causeResults.length > 0 ? top1CorrectCount / causeResults.length : null,
    top3_accuracy:
      causeResults.length > 0 ? top3CorrectCount / causeResults.length : null,
    abstention_correctness:
      abstainResults.length > 0
        ? abstentionCorrectCount / abstainResults.length
        : null,
    hallucinated_citations_blocked: sumCounts(
      'hallucinated_citations_blocked',
    ),
    remediation_citations_blocked: sumCounts('remediation_citations_blocked'),
  };
}

function normalizeTally(value) {
  const read = (field) =>
    isObject(value) &&
    Number.isInteger(value[field]) &&
    value[field] >= 0
      ? value[field]
      : 0;
  return {
    passed: read('passed'),
    evaluated: read('evaluated'),
    not_evaluated: read('not_evaluated'),
  };
}

/**
 * Adds one completed benchmark run to the running per-scenario tallies.
 *
 * `runs` counts completed benchmark runs. Each scenario accumulates
 * `passed`/`evaluated` for the display form `bench_clear 3/3`, plus a separate
 * `not_evaluated` count. Mock-fallback results only increment
 * `not_evaluated`, so a fallback cannot lower a scenario's pass rate.
 *
 * Call this once per completed run, with results deduplicated by
 * `scenario_id`. Do not call it once per resolver invocation.
 *
 * @param {{runs?: number, scenarios?: Record<string, object>}|null} previous
 * @param {object[]} results
 * @returns {{runs: number, scenarios: Record<string, {passed: number, evaluated: number, not_evaluated: number}>}}
 */
export function updateBenchmarkTallies(previous, results) {
  if (!Array.isArray(results)) {
    throw new TypeError(
      'updateBenchmarkTallies expects an array of benchmark results.',
    );
  }

  const previousRuns =
    isObject(previous) &&
    Number.isInteger(previous.runs) &&
    previous.runs >= 0
      ? previous.runs
      : 0;
  const scenarios = {};

  if (isObject(previous) && isObject(previous.scenarios)) {
    for (const [scenarioId, tally] of Object.entries(previous.scenarios)) {
      scenarios[scenarioId] = normalizeTally(tally);
    }
  }

  for (const result of results) {
    if (!isObject(result) || typeof result.scenario_id !== 'string') {
      continue;
    }

    const tally =
      scenarios[result.scenario_id] || {
        passed: 0,
        evaluated: 0,
        not_evaluated: 0,
      };

    if (result.evaluated === false) {
      tally.not_evaluated += 1;
    } else {
      tally.evaluated += 1;
      if (result.passed === true) {
        tally.passed += 1;
      }
    }

    scenarios[result.scenario_id] = tally;
  }

  return { runs: previousRuns + 1, scenarios };
}

/**
 * Runs every scenario sequentially with the injected generator.
 *
 * Sequential execution is intentional for the live path: it keeps the model
 * calls inside the resolver's time budget and avoids interleaved latency.
 *
 * The generator receives the whole scenario object. It may return an array of
 * raw hypotheses, or an object with a `hypotheses` array plus optional
 * `source`, `fallback_used`, and `fallback_reason` fields. The live wrapper
 * returns the Forge LLM result shape; tests can return either shape.
 *
 * @param {object} params
 * @param {object[]} params.scenarios
 * @param {(scenario: object) => Promise<object[]|{hypotheses: object[], source?: string, fallback_used?: boolean, fallback_reason?: string}>} params.generate
 * @returns {Promise<{label: string, results: object[], metrics: object}>}
 */
export async function runBenchmark({ scenarios, generate } = {}) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new TypeError('runBenchmark expects a non-empty array of scenarios.');
  }
  if (typeof generate !== 'function') {
    throw new TypeError('runBenchmark expects an injected generate function.');
  }

  // Validate everything up front so a bad scenario cannot produce a partial
  // result set that looks like a successful benchmark.
  const metas = scenarios.map((scenario) => validateBenchmarkScenario(scenario));
  const results = [];

  for (let index = 0; index < scenarios.length; index += 1) {
    results.push(await runScenario(scenarios[index], generate, metas[index]));
  }

  return {
    label: BENCHMARK_LABEL,
    results,
    metrics: summarizeBenchmarkResults(results),
  };
}
