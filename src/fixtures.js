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
