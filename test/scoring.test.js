import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDemoScenario } from '../src/fixtures.js';
import { createFact } from '../src/ledger.js';
import {
  applyCausalInversionGuard,
  calculateConfidence,
  rankHypotheses,
} from '../src/scoring.js';
import { generateMockHypotheses } from '../src/mockLLM.js';

const FIXED_NOW = 1760000000000;

function demoFacts() {
  return buildDemoScenario(FIXED_NOW);
}

function customFact(factId, weight, cluster, sourceSystem, factType = 'deploy') {
  return {
    fact_id: factId,
    fact_type: factType,
    source_system: sourceSystem,
    cluster,
    weight,
  };
}

function hypothesis(hypothesisId, citations) {
  return {
    hypothesis_id: hypothesisId,
    summary: 'test hypothesis',
    citations: citations.map((citation) => ({
      hypothesis_id: hypothesisId,
      ...citation,
    })),
  };
}

function assertClose(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

test('deploy and Jira ticket in the same cluster count once', () => {
  const facts = demoFacts();
  const result = calculateConfidence(
    hypothesis('hypothesis_root', [
      { fact_id: 'fact_deploy_root_001', stance: 'supports' },
      { fact_id: 'fact_jira_change_001', stance: 'supports' },
    ]),
    facts,
  );

  assert.equal(result.valid_citations.length, 2);
  assertClose(result.confidence, 0.88, 'same-cluster maximum');
  assert.notEqual(result.confidence, 1, 'same-cluster weights must not add');
  assert.equal(result.corroboration, 2);
  assert.equal(result.causal_cluster_count, 1);
  assert.deepEqual(
    result.valid_citations.map((citation) => citation.role),
    ['causal', 'causal'],
  );
});

test('remediation_action citations are rejected as root causes', () => {
  const facts = demoFacts();
  const result = calculateConfidence(
    hypothesis('hypothesis_remediation', [
      { fact_id: 'fact_remediation_001', stance: 'supports' },
    ]),
    facts,
  );

  assert.equal(result.confidence, 0);
  assert.equal(result.insufficient_evidence, true);
  assert.equal(result.causal_cluster_count, 0);
  assert.deepEqual(result.valid_citations, []);
  assert.deepEqual(
    result.blocked_citations.map((citation) => citation.fact_id),
    ['fact_remediation_001'],
  );
  assert.deepEqual(result.rejected_citations, []);

  const filtered = applyCausalInversionGuard(facts);
  assert.equal(
    filtered.some((fact) => fact.fact_id === 'fact_remediation_001'),
    false,
  );
});

test('citations to nonexistent fact IDs are ignored', () => {
  const result = calculateConfidence(
    hypothesis('hypothesis_hallucination', [
      { fact_id: 'fact_does_not_exist_999', stance: 'supports' },
    ]),
    demoFacts(),
  );

  assert.equal(result.confidence, 0);
  assert.equal(result.insufficient_evidence, true);
  assert.equal(result.corroboration, 0);
  assert.equal(result.causal_cluster_count, 0);
  assert.deepEqual(result.valid_citations, []);
  assert.deepEqual(
    result.rejected_citations.map((citation) => citation.fact_id),
    ['fact_does_not_exist_999'],
  );
});

test('a hypothesis with zero valid citations scores 0 and abstains', () => {
  const result = calculateConfidence(
    hypothesis('hypothesis_empty', []),
    demoFacts(),
  );

  assert.equal(result.confidence, 0);
  assert.equal(result.insufficient_evidence, true);
  assert.equal(result.corroboration, 0);
  assert.equal(result.causal_cluster_count, 0);
  assert.deepEqual(result.valid_citations, []);
  assert.deepEqual(result.rejected_citations, []);
  assert.deepEqual(result.blocked_citations, []);
});

test('an alert-only hypothesis is context and contributes no causal support', () => {
  const result = calculateConfidence(
    hypothesis('hypothesis_alert_only', [
      { fact_id: 'fact_alert_001', stance: 'supports' },
    ]),
    demoFacts(),
  );

  assert.equal(result.confidence, 0);
  assert.equal(result.insufficient_evidence, true);
  assert.equal(result.corroboration, 0);
  assert.equal(result.causal_cluster_count, 0);
  assert.equal(result.valid_citations.length, 1);
  assert.equal(result.valid_citations[0].role, 'context');
});

test('alert plus deploy does not exceed deploy alone', () => {
  const facts = demoFacts();
  const withAlert = calculateConfidence(
    hypothesis('hypothesis_with_alert', [
      { fact_id: 'fact_alert_001', stance: 'supports' },
      { fact_id: 'fact_deploy_root_001', stance: 'supports' },
    ]),
    facts,
  );
  const deployOnly = calculateConfidence(
    hypothesis('hypothesis_deploy_only', [
      { fact_id: 'fact_deploy_root_001', stance: 'supports' },
    ]),
    facts,
  );

  assert.equal(withAlert.confidence, deployOnly.confidence);
  assert.equal(withAlert.corroboration, deployOnly.corroboration);
  assert.equal(withAlert.causal_cluster_count, deployOnly.causal_cluster_count);
  assert.equal(withAlert.valid_citations.length, 2);

  const alertCitation = withAlert.valid_citations.find(
    (citation) => citation.fact_id === 'fact_alert_001',
  );
  assert.equal(alertCitation.role, 'context');
});

test('two causal clusters use noisy-OR and stay below 1.0', () => {
  const facts = demoFacts();
  const twoClusters = calculateConfidence(
    hypothesis('hypothesis_two_clusters', [
      { fact_id: 'fact_deploy_root_001', stance: 'supports' },
      { fact_id: 'fact_runbook_step_001', stance: 'supports' },
    ]),
    facts,
  );
  const oneCluster = calculateConfidence(
    hypothesis('hypothesis_one_cluster', [
      { fact_id: 'fact_deploy_root_001', stance: 'supports' },
    ]),
    facts,
  );

  assertClose(twoClusters.confidence, 0.9544, 'noisy-OR support');
  assert.ok(twoClusters.confidence < 1);
  assert.ok(twoClusters.confidence > oneCluster.confidence);
  assert.equal(twoClusters.causal_cluster_count, 2);
  assert.equal(twoClusters.corroboration, 2);
});

test('a decoy cited only as support scores only its low weight', () => {
  const result = calculateConfidence(
    hypothesis('hypothesis_decoy_only', [
      { fact_id: 'fact_alert_001', stance: 'supports' },
      { fact_id: 'fact_deploy_decoy_001', stance: 'supports' },
    ]),
    demoFacts(),
  );

  assertClose(result.confidence, 0.28, 'decoy weight');
  assert.ok(result.confidence < 0.5);
  assert.equal(result.corroboration, 1);
  assert.equal(result.causal_cluster_count, 1);
});

test('a decoy cited as contradicts reduces confidence', () => {
  const facts = demoFacts();
  const base = calculateConfidence(
    hypothesis('hypothesis_base', [
      { fact_id: 'fact_deploy_root_001', stance: 'supports' },
    ]),
    facts,
  );
  const contradicted = calculateConfidence(
    hypothesis('hypothesis_contradicted', [
      { fact_id: 'fact_deploy_root_001', stance: 'supports' },
      { fact_id: 'fact_deploy_decoy_001', stance: 'contradicts' },
    ]),
    facts,
  );

  assertClose(base.confidence, 0.88, 'base support');
  assertClose(contradicted.confidence, 0.6336, 'decoy contradiction');
  assert.ok(contradicted.confidence < base.confidence);
  assert.equal(contradicted.causal_cluster_count, 1);
});

test('contradicting weight reduces confidence proportionally instead of clamping to zero', () => {
  const facts = [
    customFact('fact_support', 0.4, 'signal-support', 'bitbucket'),
    customFact('fact_contradict', 0.9, 'signal-contradict', 'jira'),
  ];
  const result = calculateConfidence(
    hypothesis('hypothesis_contradicted', [
      { fact_id: 'fact_support', stance: 'supports' },
      { fact_id: 'fact_contradict', stance: 'contradicts' },
    ]),
    facts,
  );

  assertClose(result.confidence, 0.04, '0.4 * (1 - 0.9)');
  assert.equal(
    result.insufficient_evidence,
    false,
    'abstention uses support weight, not the net score',
  );
  assert.equal(result.corroboration, 1);
  assert.equal(result.causal_cluster_count, 1);
});

test('support below 0.2 sets insufficient_evidence', () => {
  const facts = [customFact('fact_weak', 0.1, 'signal-weak', 'bitbucket')];
  const result = calculateConfidence(
    hypothesis('hypothesis_weak', [
      { fact_id: 'fact_weak', stance: 'supports' },
    ]),
    facts,
  );

  assertClose(result.confidence, 0.1, 'weak support');
  assert.equal(result.insufficient_evidence, true);
});

test('the root-cause hypothesis outranks the decoy and hallucination on demo data', () => {
  const facts = demoFacts();
  const hypotheses = generateMockHypotheses(applyCausalInversionGuard(facts));

  assert.equal(hypotheses.length, 3);

  const scores = hypotheses.map((item) => calculateConfidence(item, facts));
  const [root, decoy, hallucination] = scores;

  assertClose(root.confidence, 0.6336, 'root with decoy contradiction');
  assertClose(decoy.confidence, 0.0336, 'decoy with root contradiction');
  assert.ok(root.confidence > decoy.confidence);
  assert.equal(root.corroboration, 2);
  assert.equal(decoy.corroboration, 1);
  assert.equal(root.causal_cluster_count, 1);
  assert.equal(decoy.causal_cluster_count, 1);
  assert.equal(hallucination.confidence, 0);
  assert.equal(hallucination.insufficient_evidence, true);
  assert.equal(hallucination.corroboration, 0);
  assert.equal(hallucination.causal_cluster_count, 0);
});

test('mock citations include alert context and decoy contradictions', () => {
  const hypotheses = generateMockHypotheses(
    applyCausalInversionGuard(demoFacts()),
  );
  const [root, decoy, hallucination] = hypotheses;

  assert.ok(
    root.citations.some(
      (citation) =>
        citation.fact_id === 'fact_alert_001' &&
        citation.stance === 'supports',
    ),
  );
  assert.ok(
    root.citations.some(
      (citation) =>
        citation.fact_id === 'fact_deploy_decoy_001' &&
        citation.stance === 'contradicts',
    ),
  );
  assert.ok(
    decoy.citations.some(
      (citation) =>
        citation.fact_id === 'fact_deploy_root_001' &&
        citation.stance === 'contradicts',
    ),
  );
  assert.ok(
    hallucination.citations.some(
      (citation) => citation.fact_id === 'fact_alert_001',
    ),
  );
});

test('ranking uses confidence, corroboration, then causal cluster count', () => {
  const ranked = rankHypotheses([
    {
      hypothesis_id: 'low-corroboration',
      confidence: 0.5,
      corroboration: 1,
      causal_cluster_count: 3,
    },
    {
      hypothesis_id: 'high-confidence',
      confidence: 0.6,
      corroboration: 0,
      causal_cluster_count: 0,
    },
    {
      hypothesis_id: 'few-clusters',
      confidence: 0.5,
      corroboration: 2,
      causal_cluster_count: 1,
    },
    {
      hypothesis_id: 'more-clusters',
      confidence: 0.5,
      corroboration: 2,
      causal_cluster_count: 2,
    },
  ]);

  assert.deepEqual(
    ranked.map((hypothesis) => hypothesis.hypothesis_id),
    ['high-confidence', 'more-clusters', 'few-clusters', 'low-corroboration'],
  );
  assert.deepEqual(
    ranked.map((hypothesis) => hypothesis.rank),
    [1, 2, 3, 4],
  );
});

test('mock hypothesis text matches the demo fixtures', () => {
  const hypotheses = generateMockHypotheses(
    applyCausalInversionGuard(demoFacts()),
  );

  assert.match(hypotheses[0].summary, /checkout-service v2\.14\.0/);
  assert.match(hypotheses[1].summary, /search-service v5\.2\.1/);
  for (const hypothesis of hypotheses) {
    assert.doesNotMatch(
      hypothesis.summary,
      /Deploy #482|Deploy #481|cache TTL/,
    );
  }
});

test('fixtures use evidence-signal clusters and require environment', () => {
  const facts = demoFacts();
  const byId = new Map(facts.map((fact) => [fact.fact_id, fact]));

  assert.equal(byId.get('fact_alert_001').cluster, 'symptom-checkout-latency');
  assert.equal(byId.get('fact_deploy_root_001').cluster, 'change-checkout-v2.14.0');
  assert.equal(byId.get('fact_jira_change_001').cluster, 'change-checkout-v2.14.0');
  assert.equal(byId.get('fact_deploy_decoy_001').cluster, 'change-search-v5.2.1');
  assert.equal(byId.get('fact_runbook_step_001').cluster, 'runbook-checkout');
  assert.equal(byId.get('fact_remediation_001').cluster, 'remediation-restart-checkout');

  assert.equal(byId.get('fact_alert_001').environment, 'checkout-prod');
  assert.equal(byId.get('fact_deploy_root_001').environment, 'checkout-prod');
  assert.equal(byId.get('fact_jira_change_001').environment, 'checkout-prod');
  assert.equal(byId.get('fact_deploy_decoy_001').environment, 'search-prod');
  assert.equal(byId.get('fact_runbook_step_001').environment, 'checkout-prod');
  assert.equal(byId.get('fact_remediation_001').environment, 'checkout-prod');
  for (const fact of facts) {
    assert.equal(typeof fact.environment, 'string');
    assert.ok(fact.environment.length > 0);
  }

  const reloaded = buildDemoScenario(FIXED_NOW + 60 * 1000);
  assert.deepEqual(
    reloaded.map((fact) => fact.fact_id),
    facts.map((fact) => fact.fact_id),
    'reloading must keep deterministic fact IDs',
  );

  const withoutEnvironment = { ...facts[0], fact_id: 'fact_environment_test_001' };
  delete withoutEnvironment.environment;
  assert.throws(
    () => createFact(withoutEnvironment),
    /environment/,
    'environment is required by the Fact schema',
  );
});
