import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDemoScenario } from '../src/fixtures.js';
import { createFact } from '../src/ledger.js';
import {
  applyCausalInversionGuard,
  calculateConfidence,
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
  assert.equal(result.confidence, 0.88);
  assert.notEqual(result.confidence, 1, 'same-cluster weights must not add');
  assert.equal(result.corroboration, 2);
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
  assert.deepEqual(result.valid_citations, []);
  assert.deepEqual(result.rejected_citations, []);
  assert.deepEqual(result.blocked_citations, []);
});

test('contradicting weight larger than supporting weight clamps to 0', () => {
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

  assert.equal(result.confidence, 0);
  assert.equal(
    result.insufficient_evidence,
    false,
    'abstention uses support weight, not the net score',
  );
});

test('the root-cause hypothesis outranks the decoy hypothesis on demo data', () => {
  const facts = demoFacts();
  const hypotheses = generateMockHypotheses(applyCausalInversionGuard(facts));

  assert.equal(hypotheses.length, 3);

  const scores = hypotheses.map((item) => calculateConfidence(item, facts));
  const [root, decoy, hallucination] = scores;

  assert.equal(root.confidence, 0.88);
  assert.equal(decoy.confidence, 0.28);
  assert.ok(root.confidence > decoy.confidence);
  assert.equal(root.corroboration, 2);
  assert.equal(decoy.corroboration, 1);
  assert.equal(hallucination.confidence, 0);
  assert.equal(hallucination.insufficient_evidence, true);
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
