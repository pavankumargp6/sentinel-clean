import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildBenchmarkScenarios } from '../src/fixtures.js';
import {
  BENCHMARK_LABEL,
  runBenchmark,
  scoreBenchmarkHypotheses,
  summarizeBenchmarkResults,
  updateBenchmarkTallies,
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
    case 'bench_rollback_trap':
      return [
        hypothesis('rollback_trap_true', [
          ['bench_rollback_trap_true_deploy'],
        ]),
      ];
    case 'bench_weak':
      return [hypothesis('weak_runbook', [['bench_weak_runbook']])];
    default:
      throw new Error(`Unknown benchmark scenario ${scenario.id}`);
  }
}

test('the five synthetic fixtures advertise their known ground truth', () => {
  const scenarios = buildBenchmarkScenarios(FIXED_NOW);

  assert.deepEqual(
    scenarios.map((scenario) => scenario.id),
    [
      'bench_clear',
      'bench_decoy',
      'bench_remediation',
      'bench_rollback_trap',
      'bench_weak',
    ],
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
  assert.deepEqual(scenarios[3].ground_truth, {
    cause_fact_ids: ['bench_rollback_trap_true_deploy'],
  });
  assert.deepEqual(scenarios[4].ground_truth, { abstain: true });

  // The weak scenario must stay below the proposal threshold even if every
  // weak fact is cited. This keeps "abstain" a property of the data, not a
  // property of a particular stub.
  const weak = scenarios.find((scenario) => scenario.id === 'bench_weak');
  const scoredWeak = scoreBenchmarkHypotheses(
    [hypothesis('weak_all', weak.facts.map((fact) => [fact.fact_id]))],
    weak.facts,
  );
  assert.ok(
    scoredWeak[0].confidence < 0.5,
    `expected weak support below 0.5, got ${scoredWeak[0].confidence}`,
  );

  // A remediation-only hypothesis must score zero and be reported as blocked.
  const remediation = scenarios.find(
    (scenario) => scenario.id === 'bench_remediation',
  );
  const scoredRemediation = scoreBenchmarkHypotheses(
    [hypothesis('remediation_only', [['bench_remediation_action']])],
    remediation.facts,
  );
  assert.equal(scoredRemediation[0].confidence, 0);
  assert.deepEqual(scoredRemediation[0].blocked_citation_ids, [
    'bench_remediation_action',
  ]);
});

test('the rollback trap puts the remediation action before the alert', () => {
  const scenario = buildBenchmarkScenarios(FIXED_NOW).find(
    (candidate) => candidate.id === 'bench_rollback_trap',
  );
  const alert = scenario.facts.find(
    (fact) => fact.fact_id === 'bench_rollback_trap_alert',
  );
  const action = scenario.facts.find(
    (fact) => fact.fact_id === 'bench_rollback_trap_action',
  );
  const trueDeploy = scenario.facts.find(
    (fact) => fact.fact_id === 'bench_rollback_trap_true_deploy',
  );

  assert.ok(alert);
  assert.ok(action);
  assert.ok(trueDeploy);
  assert.equal(action.fact_type, 'remediation_action');
  assert.match(action.summary, /rolled back/i);
  assert.ok(
    Date.parse(action.observed_at) < Date.parse(alert.observed_at),
    'the rollback must precede the alert to look like a trigger',
  );
  assert.ok(
    action.weight > trueDeploy.weight,
    'the bait should look stronger by the stored weight',
  );

  // The citation is blocked even when the generator takes the bait.
  const scored = scoreBenchmarkHypotheses(
    [hypothesis('rollback_bait', [['bench_rollback_trap_action']])],
    scenario.facts,
  );
  assert.equal(scored[0].confidence, 0);
  assert.deepEqual(scored[0].blocked_citation_ids, [
    'bench_rollback_trap_action',
  ]);
});

test('all five scenarios pass with a stubbed generator', async () => {
  const scenarios = buildBenchmarkScenarios(FIXED_NOW);
  const result = await runBenchmark({
    scenarios,
    generate: passingGenerator,
  });

  assert.equal(result.label, BENCHMARK_LABEL);
  assert.equal(result.results.length, 5);
  assert.equal(result.metrics.scenario_count, 5);
  assert.equal(result.metrics.evaluated_scenario_count, 5);
  assert.equal(result.metrics.not_evaluated_count, 0);
  assert.equal(result.metrics.cause_scenario_count, 4);
  assert.equal(result.metrics.abstain_scenario_count, 1);
  assert.equal(result.metrics.passed_count, 5);
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

  const rollbackTrap = result.results.find(
    (scenario) => scenario.scenario_id === 'bench_rollback_trap',
  );
  assert.equal(rollbackTrap.evaluated, true);
  assert.equal(rollbackTrap.source_label, 'LLM');
  assert.equal(rollbackTrap.passed, true);

  const weak = result.results.find(
    (scenario) => scenario.scenario_id === 'bench_weak',
  );
  assert.equal(weak.abstained, true);
  assert.equal(weak.passed, true);
  assert.equal(weak.predicted_label, 'abstain');
});

test('mock-fallback scenarios are not evaluated and excluded from accuracy', async () => {
  const scenarios = buildBenchmarkScenarios(FIXED_NOW);
  const clear = scenarios.find((scenario) => scenario.id === 'bench_clear');
  const decoy = scenarios.find((scenario) => scenario.id === 'bench_decoy');

  const result = await runBenchmark({
    scenarios: [clear, decoy],
    generate: (scenario) => {
      if (scenario.id === 'bench_clear') {
        // A correct mock answer must not earn a pass or enter accuracy.
        return {
          hypotheses: [hypothesis('clear_mock', [['bench_clear_deploy']])],
          source: 'mock',
          fallback_used: true,
          fallback_reason: 'test timeout',
        };
      }
      // The only evaluated prediction is wrong, so top-1 accuracy must be 0,
      // not the 50% that including the mock fallback would produce.
      return [hypothesis('decoy_wrong', [['bench_decoy_false_deploy']])];
    },
  });

  const clearResult = result.results.find(
    (scenario) => scenario.scenario_id === 'bench_clear',
  );
  const decoyResult = result.results.find(
    (scenario) => scenario.scenario_id === 'bench_decoy',
  );

  assert.equal(clearResult.evaluated, false);
  assert.equal(clearResult.source, 'mock');
  assert.equal(clearResult.source_label, 'Mock fallback');
  assert.equal(clearResult.passed, null);
  assert.equal(clearResult.top1_correct, null);
  assert.equal(clearResult.top3_correct, null);
  assert.match(clearResult.not_evaluated_reason, /mock fallback/i);
  assert.match(clearResult.not_evaluated_reason, /test timeout/);

  assert.equal(decoyResult.evaluated, true);
  assert.equal(decoyResult.source, 'llm');
  assert.equal(decoyResult.source_label, 'LLM');

  assert.equal(result.metrics.scenario_count, 2);
  assert.equal(result.metrics.evaluated_scenario_count, 1);
  assert.equal(result.metrics.not_evaluated_count, 1);
  assert.equal(result.metrics.cause_scenario_count, 1);
  assert.equal(result.metrics.top1_accuracy, 0);
  assert.equal(result.metrics.top3_accuracy, 0);
  assert.equal(result.metrics.passed_count, 0);
});

test('summarizeBenchmarkResults returns null accuracy when nothing was evaluated', () => {
  const metrics = summarizeBenchmarkResults([
    {
      scenario_id: 'mock_only',
      expected_abstain: false,
      evaluated: false,
      source: 'mock',
      passed: null,
      top1_correct: null,
      top3_correct: null,
    },
  ]);

  assert.equal(metrics.scenario_count, 1);
  assert.equal(metrics.evaluated_scenario_count, 0);
  assert.equal(metrics.not_evaluated_count, 1);
  assert.equal(metrics.cause_scenario_count, 0);
  assert.equal(metrics.top1_accuracy, null);
  assert.equal(metrics.top3_accuracy, null);
  assert.equal(metrics.abstention_correctness, null);
  assert.equal(metrics.passed_count, 0);
});

test('running tallies count passes per scenario and skip mock fallbacks', async () => {
  const scenarios = buildBenchmarkScenarios(FIXED_NOW);
  const passingRun = await runBenchmark({
    scenarios,
    generate: passingGenerator,
  });

  let tallies = { runs: 0, scenarios: {} };
  tallies = updateBenchmarkTallies(tallies, passingRun.results);
  assert.equal(tallies.runs, 1);
  for (const scenario of scenarios) {
    assert.deepEqual(tallies.scenarios[scenario.id], {
      passed: 1,
      evaluated: 1,
      not_evaluated: 0,
    });
  }

  // Two more completed runs produce the display form "bench_clear 3/3".
  tallies = updateBenchmarkTallies(tallies, passingRun.results);
  tallies = updateBenchmarkTallies(tallies, passingRun.results);
  assert.equal(tallies.runs, 3);
  assert.deepEqual(tallies.scenarios.bench_clear, {
    passed: 3,
    evaluated: 3,
    not_evaluated: 0,
  });

  const fallbackRun = await runBenchmark({
    scenarios: [scenarios.find((scenario) => scenario.id === 'bench_clear')],
    generate: () => ({
      hypotheses: [hypothesis('clear_mock', [['bench_clear_deploy']])],
      source: 'mock',
      fallback_used: true,
    }),
  });
  tallies = updateBenchmarkTallies(tallies, fallbackRun.results);

  assert.equal(tallies.runs, 4);
  assert.deepEqual(tallies.scenarios.bench_clear, {
    passed: 3,
    evaluated: 3,
    not_evaluated: 1,
  });
});

test('a stubbed generator that cites the rollback trap is blocked and counted', async () => {
  const scenario = buildBenchmarkScenarios(FIXED_NOW).find(
    (candidate) => candidate.id === 'bench_rollback_trap',
  );

  const withTrueCause = await runBenchmark({
    scenarios: [scenario],
    generate: () => [
      hypothesis('trap_with_true_cause', [
        ['bench_rollback_trap_action'],
        ['bench_rollback_trap_true_deploy'],
      ]),
    ],
  });
  const passingResult = withTrueCause.results[0];

  assert.equal(passingResult.evaluated, true);
  assert.equal(passingResult.passed, true);
  assert.equal(passingResult.remediation_citations_blocked, 1);
  assert.deepEqual(passingResult.top_hypotheses[0].blocked_citation_ids, [
    'bench_rollback_trap_action',
  ]);
  assert.deepEqual(passingResult.predicted_cause_fact_ids, [
    'bench_rollback_trap_true_deploy',
  ]);
  assert.equal(withTrueCause.metrics.remediation_citations_blocked, 1);

  const baitOnly = await runBenchmark({
    scenarios: [scenario],
    generate: () => [
      hypothesis('trap_bait_only', [['bench_rollback_trap_action']]),
    ],
  });
  const baitResult = baitOnly.results[0];

  assert.equal(baitResult.confidence, 0);
  assert.equal(baitResult.abstained, true);
  assert.equal(baitResult.passed, false);
  assert.equal(baitResult.remediation_citations_blocked, 1);
  assert.deepEqual(baitResult.top_hypotheses[0].blocked_citation_ids, [
    'bench_rollback_trap_action',
  ]);
  assert.equal(baitOnly.metrics.top1_accuracy, 0);
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
  const weak = scenarios.find((scenario) => scenario.id === 'bench_weak');
  const result = await runBenchmark({
    scenarios: [scenarios[0], weak],
    generate: () => {
      throw new Error('model unavailable');
    },
  });

  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].error, 'model unavailable');
  assert.equal(result.results[0].evaluated, true);
  assert.equal(result.results[0].source_label, 'LLM');
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
