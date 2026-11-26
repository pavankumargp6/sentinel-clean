import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildBenchmarkScenarios } from '../src/fixtures.js';
import {
  BENCHMARK_LABEL,
  runBenchmark,
  scoreBenchmarkHypotheses,
  summarizeBenchmarkResults,
  validateBenchmarkScenario,
} from '../src/benchmark.js';

const FIXED_NOW = 1760000000000;

function hypothesis(id, citations) {
  return {
    hypothesis_id: id,
    summary: `summary for ${id}`,
    citations: citations.map(([factId, stance = 'supports']) => ({
      hypothesis_id: id,
      fact_id: factId,
      stance,
    })),
  };
}

function passingGenerator(scenario) {
  switch (scenario.id) {
    case 'bench_clear':
      return [
        hypothesis('clear_top', [
          ['bench_clear_deploy'],
          ['bench_clear_alert'],
        ]),
      ];
    case 'bench_decoy':
      return [
        hypothesis('decoy_true', [['bench_decoy_true_deploy']]),
        hypothesis('decoy_false', [['bench_decoy_false_deploy']]),
      ];
    case 'bench_remediation':
      return [
        hypothesis('remediation_true', [
          ['bench_remediation_true_deploy'],
          ['bench_remediation_action'],
        ]),
        hypothesis('remediation_only', [['bench_remediation_action']]),
      ];
    case 'bench_weak':
      return [hypothesis('weak_runbook', [['bench_weak_runbook']])];
    default:
      throw new Error(`Unknown benchmark scenario ${scenario.id}`);
  }
}

test('the four synthetic fixtures advertise their known ground truth', () => {
  const scenarios = buildBenchmarkScenarios(FIXED_NOW);

  assert.deepEqual(
    scenarios.map((scenario) => scenario.id),
    ['bench_clear', 'bench_decoy', 'bench_remediation', 'bench_weak'],
  );
  assert.deepEqual(scenarios[0].ground_truth, {
    cause_fact_ids: ['bench_clear_deploy'],
  });
  assert.deepEqual(scenarios[1].ground_truth, {
    cause_fact_ids: ['bench_decoy_true_deploy'],
  });
  assert.deepEqual(scenarios[2].ground_truth, {
    cause_fact_ids: ['bench_remediation_true_deploy'],
  });
  assert.deepEqual(scenarios[3].ground_truth, { abstain: true });

  // The weak scenario must stay below the proposal threshold even if every
  // weak fact is cited. This keeps "abstain" a property of the data, not a
  // property of a particular stub.
  const weak = scenarios[3];
  const scoredWeak = scoreBenchmarkHypotheses(
    [hypothesis('weak_all', weak.facts.map((fact) => [fact.fact_id]))],
    weak.facts,
  );
  assert.ok(
    scoredWeak[0].confidence < 0.5,
    `expected weak support below 0.5, got ${scoredWeak[0].confidence}`,
  );

  // A remediation-only hypothesis must score zero and be reported as blocked.
  const remediation = scenarios[2];
  const scoredRemediation = scoreBenchmarkHypotheses(
    [hypothesis('remediation_only', [['bench_remediation_action']])],
    remediation.facts,
  );
  assert.equal(scoredRemediation[0].confidence, 0);
  assert.deepEqual(scoredRemediation[0].blocked_citation_ids, [
    'bench_remediation_action',
  ]);
});

test('all four scenarios pass with a stubbed generator', async () => {
  const scenarios = buildBenchmarkScenarios(FIXED_NOW);
  const result = await runBenchmark({
    scenarios,
    generate: passingGenerator,
  });

  assert.equal(result.label, BENCHMARK_LABEL);
  assert.equal(result.results.length, 4);
  assert.equal(result.metrics.scenario_count, 4);
  assert.equal(result.metrics.cause_scenario_count, 3);
  assert.equal(result.metrics.abstain_scenario_count, 1);
  assert.equal(result.metrics.passed_count, 4);
  assert.equal(result.metrics.error_count, 0);
  assert.equal(result.metrics.top1_accuracy, 1);
  assert.equal(result.metrics.top3_accuracy, 1);
  assert.equal(result.metrics.abstention_correctness, 1);
  assert.equal(result.metrics.hallucinated_citations_blocked, 0);
  assert.equal(result.metrics.remediation_citations_blocked, 2);

  const remediation = result.results.find(
    (scenario) => scenario.scenario_id === 'bench_remediation',
  );
  assert.equal(remediation.passed, true);
  assert.equal(remediation.abstained, false);
  assert.ok(!remediation.predicted_cause_fact_ids.includes('bench_remediation_action'));
  assert.equal(remediation.remediation_citations_blocked, 2);

  const weak = result.results.find(
    (scenario) => scenario.scenario_id === 'bench_weak',
  );
  assert.equal(weak.abstained, true);
  assert.equal(weak.passed, true);
  assert.equal(weak.predicted_label, 'abstain');
});

test('hallucinated citations are counted as blocked and cannot support a cause', async () => {
  const scenarios = buildBenchmarkScenarios(FIXED_NOW);
  const clear = scenarios.find((scenario) => scenario.id === 'bench_clear');

  const result = await runBenchmark({
    scenarios: [clear],
    generate: () => [
      hypothesis('clear_with_fake', [
        ['bench_clear_deploy'],
        ['fact_missing_999'],
      ]),
    ],
  });

  assert.equal(result.results[0].passed, true);
  assert.equal(result.metrics.hallucinated_citations_blocked, 1);
  assert.deepEqual(
    result.results[0].top_hypotheses[0].rejected_citation_ids,
    ['fact_missing_999'],
  );
});

test('a hypothesis that cites only a nonexistent fact abstains and fails', async () => {
  const scenarios = buildBenchmarkScenarios(FIXED_NOW);
  const clear = scenarios.find((scenario) => scenario.id === 'bench_clear');

  const result = await runBenchmark({
    scenarios: [clear],
    generate: () => [hypothesis('fake_only', [['fact_missing_999']])],
  });

  assert.equal(result.results[0].abstained, true);
  assert.equal(result.results[0].passed, false);
  assert.equal(result.results[0].top1_correct, false);
  assert.equal(result.metrics.top1_accuracy, 0);
  assert.equal(result.metrics.hallucinated_citations_blocked, 1);
});

test('predicting the decoy deploys fails the cause scenario', async () => {
  const scenarios = buildBenchmarkScenarios(FIXED_NOW);
  const decoy = scenarios.find((scenario) => scenario.id === 'bench_decoy');

  const result = await runBenchmark({
    scenarios: [decoy],
    generate: () => [
      hypothesis('decoy_wrong', [['bench_decoy_false_deploy']]),
    ],
  });

  assert.equal(result.results[0].abstained, true);
  assert.equal(result.results[0].passed, false);
  assert.equal(result.results[0].top1_correct, false);
  assert.equal(result.results[0].top3_correct, false);
  assert.equal(result.metrics.top1_accuracy, 0);
});

test('abstention correctness fails when a strong hypothesis clears 0.5', async () => {
  const scenario = {
    id: 'test_abstain_failure',
    facts: [
      {
        fact_id: 'strong_signal',
        fact_type: 'deploy',
        source_system: 'bitbucket',
        cluster: 'strong',
        weight: 0.9,
      },
    ],
    ground_truth: { abstain: true },
  };

  const result = await runBenchmark({
    scenarios: [scenario],
    generate: () => [hypothesis('strong', [['strong_signal']])],
  });

  assert.equal(result.results[0].abstained, false);
  assert.equal(result.results[0].passed, false);
  assert.equal(result.metrics.abstention_correctness, 0);
  assert.equal(result.metrics.abstention_correct_count, 0);
  assert.equal(result.metrics.abstain_scenario_count, 1);
});

test('top-3 accuracy can pass when top-1 is wrong', async () => {
  const scenario = {
    id: 'test_top3',
    facts: [
      {
        fact_id: 'fact_true',
        fact_type: 'deploy',
        source_system: 'bitbucket',
        cluster: 'true',
        weight: 0.5,
      },
      {
        fact_id: 'fact_b',
        fact_type: 'deploy',
        source_system: 'bitbucket',
        cluster: 'b',
        weight: 0.9,
      },
      {
        fact_id: 'fact_c',
        fact_type: 'deploy',
        source_system: 'bitbucket',
        cluster: 'c',
        weight: 0.8,
      },
    ],
    ground_truth: { cause_fact_ids: ['fact_true'] },
  };

  const result = await runBenchmark({
    scenarios: [scenario],
    generate: () => [
      hypothesis('b', [['fact_b']]),
      hypothesis('c', [['fact_c']]),
      hypothesis('true', [['fact_true']]),
    ],
  });

  assert.equal(result.results[0].top1_correct, false);
  assert.equal(result.results[0].top3_correct, true);
  assert.equal(result.results[0].passed, false);
  assert.equal(result.metrics.top1_accuracy, 0);
  assert.equal(result.metrics.top3_accuracy, 1);
});

test('a generator error is recorded as a failure, not thrown', async () => {
  const scenarios = buildBenchmarkScenarios(FIXED_NOW);
  const result = await runBenchmark({
    scenarios: [scenarios[0], scenarios[3]],
    generate: () => {
      throw new Error('model unavailable');
    },
  });

  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].error, 'model unavailable');
  assert.equal(result.results[0].passed, false);
  assert.equal(result.results[1].passed, false);
  assert.equal(result.results[1].abstained, false);
  assert.equal(result.metrics.error_count, 2);
  assert.equal(result.metrics.top1_accuracy, 0);
  assert.equal(result.metrics.abstention_correctness, 0);
});

test('metrics can be recomputed across resolver invocations', async () => {
  const scenarios = buildBenchmarkScenarios(FIXED_NOW);
  const first = await runBenchmark({
    scenarios: [scenarios[0]],
    generate: passingGenerator,
  });
  const second = await runBenchmark({
    scenarios: [scenarios[1]],
    generate: passingGenerator,
  });
  const combined = summarizeBenchmarkResults([
    ...first.results,
    ...second.results,
  ]);
  const together = await runBenchmark({
    scenarios: scenarios.slice(0, 2),
    generate: passingGenerator,
  });

  assert.deepEqual(combined, together.metrics);
  assert.equal(combined.scenario_count, 2);
  assert.equal(combined.top1_accuracy, 1);
});

test('benchmark module has no KVS or proposal/audit storage dependency', () => {
  const source = readFileSync(
    new URL('../src/benchmark.js', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /@forge\/kvs/);
  assert.doesNotMatch(source, /kvs\./);
  assert.doesNotMatch(
    source,
    /LAST_RUN_KEY|LAST_PROPOSAL_KEY|proposalKey|auditKey/,
  );
});

test('malformed scenarios fail before the generator is called', async () => {
  assert.throws(
    () =>
      validateBenchmarkScenario({
        id: 'bad',
        facts: [],
        ground_truth: { abstain: true },
      }),
    /at least one fact/,
  );
  assert.throws(
    () =>
      validateBenchmarkScenario({
        id: 'bad',
        facts: [{ fact_id: 'fact_a' }],
        ground_truth: { abstain: true, cause_fact_ids: ['fact_a'] },
      }),
    /cannot both/,
  );
  assert.throws(
    () =>
      validateBenchmarkScenario({
        id: 'bad',
        facts: [{ fact_id: 'fact_a' }],
        ground_truth: {},
      }),
    /must list/,
  );

  await assert.rejects(
    () => runBenchmark({ scenarios: [], generate: () => [] }),
    /non-empty array/,
  );
  await assert.rejects(
    () =>
      runBenchmark({
        scenarios: buildBenchmarkScenarios(FIXED_NOW).slice(0, 1),
        generate: null,
      }),
    /generate function/,
  );
});
