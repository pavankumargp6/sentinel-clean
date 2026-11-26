/**
 * Demo fixtures for the Sentinel incident ledger.
 *
 * There are no Bitbucket, Jira, PagerDuty, or runbook API calls here. The
 * source_system/source_ref values are labels that make the demo scenario
 * readable; they do not claim a live integration.
 *
 * observed_at is computed from a single `now` captured once per build. The
 * resolver writes those strings to Forge KVS, and getLedger never rebuilds
 * them. Rebuilding the demo refreshes the timestamps, but the fact_ids stay
 * deterministic so repeated loads overwrite the same keys.
 */
import { createFact } from './ledger.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * Builds the one demo incident scenario.
 *
 * @param {number} [now] - Epoch milliseconds used as the scenario's "now".
 *   Pass a fixed value in tests; production calls use the current time once.
 * @returns {object[]} Six validated facts.
 */
export function buildDemoScenario(now = Date.now()) {
  const observedAt = (millisecondsAgo) =>
    new Date(now - millisecondsAgo).toISOString();

  return [
    createFact({
      fact_id: 'fact_alert_001',
      fact_type: 'alert',
      source_system: 'pagerduty',
      source_ref: 'PD-INC-4417',
      observed_at: observedAt(9 * MINUTE),
      service_scope: ['checkout-service', 'payments'],
      summary:
        'p99 checkout latency crossed 2.4s and the error rate reached 7% in checkout-prod.',
      // Provisional demo prior: a fresh, high-severity alert is strong evidence
      // of impact, but it does not establish the cause by itself.
      weight: 0.93,
      cluster: 'symptom-checkout-latency',
      environment: 'checkout-prod',
    }),
    createFact({
      fact_id: 'fact_deploy_root_001',
      fact_type: 'deploy',
      source_system: 'bitbucket',
      source_ref: 'commit:9f3c2a1',
      observed_at: observedAt(28 * MINUTE),
      service_scope: ['checkout-service', 'pricing'],
      summary:
        'checkout-service v2.14.0 deployed; added synchronous tax calculation to the checkout request path.',
      // Provisional demo prior: a recent deploy in the same change cluster is a
      // strong root-cause candidate, but this is a hand-assigned demo weight.
      weight: 0.88,
      cluster: 'change-checkout-v2.14.0',
      environment: 'checkout-prod',
    }),
    createFact({
      fact_id: 'fact_deploy_decoy_001',
      fact_type: 'deploy',
      source_system: 'bitbucket',
      source_ref: 'commit:5d81b0e',
      observed_at: observedAt(16 * MINUTE),
      service_scope: ['search-service', 'indexing'],
      summary:
        'search-service v5.2.1 deployed to search-prod; it shares no services with checkout.',
      // Provisional demo prior: recent, but the change cluster and service scope
      // do not match the incident. The low weight is a decoy signal, not a verdict.
      weight: 0.28,
      cluster: 'change-search-v5.2.1',
      environment: 'search-prod',
    }),
    createFact({
      fact_id: 'fact_jira_change_001',
      fact_type: 'jira_issue',
      source_system: 'jira',
      source_ref: 'OPS-1421',
      observed_at: observedAt(3 * HOUR),
      service_scope: ['checkout-service', 'pricing'],
      summary:
        'Change OPS-1421 approved the tax-calculation rollout for checkout-service in checkout-prod.',
      // Provisional demo prior: an approval record explains intent and timing,
      // but it is not runtime evidence that the deploy caused the alert.
      weight: 0.76,
      cluster: 'change-checkout-v2.14.0',
      environment: 'checkout-prod',
    }),
    createFact({
      fact_id: 'fact_runbook_step_001',
      fact_type: 'runbook_step',
      source_system: 'runbook',
      source_ref: 'RB-CHECKOUT-07#step-3',
      observed_at: observedAt(6 * MINUTE),
      service_scope: ['checkout-service'],
      summary:
        'Runbook step 3: compare checkout p99 latency before and after the v2.14.0 deploy.',
      // Provisional demo prior: a diagnostic step is useful context, but it is
      // weaker evidence than a live alert or a matching deploy.
      weight: 0.62,
      cluster: 'runbook-checkout',
      environment: 'checkout-prod',
    }),
    createFact({
      fact_id: 'fact_remediation_001',
      fact_type: 'remediation_action',
      source_system: 'sentinel',
      source_ref: 'action:restart-checkout-001',
      observed_at: observedAt(2 * MINUTE),
      service_scope: ['checkout-service', 'payments'],
      summary:
        'Recorded demo action: restart checkout-service pods to clear the tax-calculation thread pool. Not executed by this app.',
      // Provisional demo prior: a recorded mitigation is evidence of what the
      // responder tried, not proof that it worked.
      weight: 0.54,
      cluster: 'remediation-restart-checkout',
      environment: 'checkout-prod',
    }),
  ];
}

/**
 * Builds the four synthetic benchmark scenarios.
 *
 * These are authored by the developer for evaluation only. They are not live
 * incidents and are not written to the real ledger. Each scenario has a known
 * ground truth: either the fact ID of the true cause, or `{ abstain: true }`
 * when no hypothesis should clear the 0.5 confidence threshold.
 *
 * The fact IDs are stable so a benchmark run is reproducible. Timestamps are
 * relative to one `now` per build, which keeps the ordering stable without
 * making the scenarios depend on wall-clock time.
 *
 * @param {number} [now] - Epoch milliseconds used as the scenarios' "now".
 * @returns {{id: string, facts: object[], ground_truth: object}[]}
 */
export function buildBenchmarkScenarios(now = Date.now()) {
  const observedAt = (millisecondsAgo) =>
    new Date(now - millisecondsAgo).toISOString();

  return [
    {
      // One deploy and its change ticket. The deploy is the only ground-truth
      // cause; the ticket is same-cluster context, not a second cause.
      id: 'bench_clear',
      facts: [
        createFact({
          fact_id: 'bench_clear_alert',
          fact_type: 'alert',
          source_system: 'pagerduty',
          source_ref: 'BENCH-CLEAR-ALERT',
          observed_at: observedAt(8 * MINUTE),
          service_scope: ['payments-service'],
          summary:
            'payments-service p99 latency rose to 1.9s and the error rate reached 5% in payments-prod.',
          weight: 0.92,
          cluster: 'bench-clear-symptom',
          environment: 'payments-prod',
        }),
        createFact({
          fact_id: 'bench_clear_deploy',
          fact_type: 'deploy',
          source_system: 'bitbucket',
          source_ref: 'commit:bench-clear',
          observed_at: observedAt(25 * MINUTE),
          service_scope: ['payments-service'],
          summary:
            'payments-service v3.8.0 deployed; switched the card authorization path to a new retry loop.',
          weight: 0.9,
          cluster: 'bench-clear-change',
          environment: 'payments-prod',
        }),
        createFact({
          fact_id: 'bench_clear_ticket',
          fact_type: 'jira_issue',
          source_system: 'jira',
          source_ref: 'OPS-8101',
          observed_at: observedAt(2 * HOUR),
          service_scope: ['payments-service'],
          summary:
            'Change OPS-8101 approved the payments-service v3.8.0 retry-loop rollout.',
          weight: 0.8,
          cluster: 'bench-clear-change',
          environment: 'payments-prod',
        }),
      ],
      ground_truth: { cause_fact_ids: ['bench_clear_deploy'] },
    },
    {
      // A recent unrelated deploy is the decoy. The older checkout deploy is
      // the true cause, so a recency-only answer will fail.
      id: 'bench_decoy',
      facts: [
        createFact({
          fact_id: 'bench_decoy_alert',
          fact_type: 'alert',
          source_system: 'pagerduty',
          source_ref: 'BENCH-DECOY-ALERT',
          observed_at: observedAt(7 * MINUTE),
          service_scope: ['checkout-service'],
          summary:
            'checkout-service p99 latency rose to 2.2s and the error rate reached 6% in checkout-prod.',
          weight: 0.92,
          cluster: 'bench-decoy-symptom',
          environment: 'checkout-prod',
        }),
        createFact({
          fact_id: 'bench_decoy_true_deploy',
          fact_type: 'deploy',
          source_system: 'bitbucket',
          source_ref: 'commit:bench-decoy-true',
          observed_at: observedAt(27 * MINUTE),
          service_scope: ['checkout-service'],
          summary:
            'checkout-service v4.2.0 deployed; moved discount calculation into the synchronous checkout request path.',
          weight: 0.9,
          cluster: 'bench-decoy-change',
          environment: 'checkout-prod',
        }),
        createFact({
          fact_id: 'bench_decoy_false_deploy',
          fact_type: 'deploy',
          source_system: 'bitbucket',
          source_ref: 'commit:bench-decoy-false',
          observed_at: observedAt(4 * MINUTE),
          service_scope: ['search-service'],
          summary:
            'search-service v9.1.0 deployed to search-prod; it shares no services with checkout.',
          weight: 0.2,
          cluster: 'bench-decoy-distractor',
          environment: 'search-prod',
        }),
        createFact({
          fact_id: 'bench_decoy_ticket',
          fact_type: 'jira_issue',
          source_system: 'jira',
          source_ref: 'OPS-8202',
          observed_at: observedAt(3 * HOUR),
          service_scope: ['checkout-service'],
          summary:
            'Change OPS-8202 approved the checkout-service v4.2.0 discount-calculation rollout.',
          weight: 0.78,
          cluster: 'bench-decoy-change',
          environment: 'checkout-prod',
        }),
      ],
      ground_truth: { cause_fact_ids: ['bench_decoy_true_deploy'] },
    },
    {
      // The remediation action is the most recent and has the highest stored
      // weight, so it looks causal by timing alone. The real change is the
      // older deploy. The Causal Inversion Guard must keep the remediation out
      // of the model's input and the scorer must block any citation to it.
      id: 'bench_remediation',
      facts: [
        createFact({
          fact_id: 'bench_remediation_alert',
          fact_type: 'alert',
          source_system: 'pagerduty',
          source_ref: 'BENCH-REMEDIATION-ALERT',
          observed_at: observedAt(9 * MINUTE),
          service_scope: ['checkout-service'],
          summary:
            'checkout-service p99 latency rose to 2.5s after the v4.3.0 rollout in checkout-prod.',
          weight: 0.92,
          cluster: 'bench-remediation-symptom',
          environment: 'checkout-prod',
        }),
        createFact({
          fact_id: 'bench_remediation_true_deploy',
          fact_type: 'deploy',
          source_system: 'bitbucket',
          source_ref: 'commit:bench-remediation-true',
          observed_at: observedAt(30 * MINUTE),
          service_scope: ['checkout-service'],
          summary:
            'checkout-service v4.3.0 deployed; added a synchronous loyalty-points lookup to checkout.',
          weight: 0.9,
          cluster: 'bench-remediation-change',
          environment: 'checkout-prod',
        }),
        createFact({
          fact_id: 'bench_remediation_ticket',
          fact_type: 'jira_issue',
          source_system: 'jira',
          source_ref: 'OPS-8303',
          observed_at: observedAt(3 * HOUR),
          service_scope: ['checkout-service'],
          summary:
            'Change OPS-8303 approved the checkout-service v4.3.0 loyalty-points rollout.',
          weight: 0.78,
          cluster: 'bench-remediation-change',
          environment: 'checkout-prod',
        }),
        createFact({
          fact_id: 'bench_remediation_action',
          fact_type: 'remediation_action',
          source_system: 'sentinel',
          source_ref: 'action:bench-rollback',
          observed_at: observedAt(3 * MINUTE),
          service_scope: ['checkout-service'],
          summary:
            'Recorded response: rolled back checkout-service to v4.2.9. Not executed by this app.',
          weight: 0.95,
          cluster: 'bench-remediation-action',
          environment: 'checkout-prod',
        }),
      ],
      ground_truth: { cause_fact_ids: ['bench_remediation_true_deploy'] },
    },
    {
      // Only an alert and weak, non-causal context are available. Even if the
      // model cites every weak fact, their noisy-OR support stays below 0.5:
      // 1 - (1-0.18)(1-0.22)(1-0.15) = 0.45634. The correct output is abstain.
      id: 'bench_weak',
      facts: [
        createFact({
          fact_id: 'bench_weak_alert',
          fact_type: 'alert',
          source_system: 'pagerduty',
          source_ref: 'BENCH-WEAK-ALERT',
          observed_at: observedAt(12 * MINUTE),
          service_scope: ['checkout-service'],
          summary:
            'checkout-service p99 latency briefly crossed 2.1s in checkout-prod; the alert has not repeated.',
          weight: 0.9,
          cluster: 'bench-weak-symptom',
          environment: 'checkout-prod',
        }),
        createFact({
          fact_id: 'bench_weak_runbook',
          fact_type: 'runbook_step',
          source_system: 'runbook',
          source_ref: 'RB-BENCH-WEAK#step-1',
          observed_at: observedAt(10 * MINUTE),
          service_scope: ['checkout-service'],
          summary:
            'Runbook step: compare the alert time with deploys, but no deploy fact exists in this scenario.',
          weight: 0.18,
          cluster: 'bench-weak-runbook',
          environment: 'checkout-prod',
        }),
        createFact({
          fact_id: 'bench_weak_prior',
          fact_type: 'prior_incident',
          source_system: 'sentinel',
          source_ref: 'INC-BENCH-WEAK-OLD',
          observed_at: observedAt(2 * HOUR),
          service_scope: ['checkout-service'],
          summary:
            'A similar latency alert three weeks ago was traced to a database failover; no failover fact exists today.',
          weight: 0.22,
          cluster: 'bench-weak-prior',
          environment: 'checkout-prod',
        }),
        createFact({
          fact_id: 'bench_weak_jira',
          fact_type: 'jira_issue',
          source_system: 'jira',
          source_ref: 'OPS-8404',
          observed_at: observedAt(4 * HOUR),
          service_scope: ['checkout-service'],
          summary:
            'OPS-8404 is an unapproved proposal to tune checkout timeouts; no change was deployed.',
          weight: 0.15,
          cluster: 'bench-weak-change',
          environment: 'checkout-prod',
        }),
      ],
      ground_truth: { abstain: true },
    },
  ];
}

/**
 * Seeded demo blast-radius table.
 *
 * This is intentionally small, hand-entered demo data for the checkout
 * incident. It is NOT a live service graph, discovery result, or simulated
 * dependency model. Do not treat it as real ownership or topology data.
 */
export const BLAST_RADIUS = Object.freeze({
  'checkout-service': Object.freeze({
    service: 'checkout-service',
    owner: 'checkout-team',
    dependents: Object.freeze(['payments', 'tax-service', 'frontend']),
  }),
  payments: Object.freeze({
    service: 'payments',
    owner: 'payments-team',
    dependents: Object.freeze(['checkout-service']),
  }),
  'tax-service': Object.freeze({
    service: 'tax-service',
    owner: 'pricing-team',
    dependents: Object.freeze(['checkout-service']),
  }),
  frontend: Object.freeze({
    service: 'frontend',
    owner: 'web-team',
    dependents: Object.freeze(['checkout-service']),
  }),
  'search-service': Object.freeze({
    service: 'search-service',
    owner: 'search-team',
    dependents: Object.freeze(['indexing']),
  }),
  indexing: Object.freeze({
    service: 'indexing',
    owner: 'search-team',
    dependents: Object.freeze(['search-service']),
  }),
});
