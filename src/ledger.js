/**
 * Sentinel ledger: the Fact schema, storage-key helpers, and tunable priors.
 *
 * This file is plain JavaScript with no Forge imports. It can be imported by
 * fixtures, resolvers, and future scoring code without pulling in the Forge
 * runtime. Storage itself lives in src/index.js.
 *
 * @typedef {object} Fact
 * @property {string} fact_id - Deterministic ID, for example fact_deploy_root_001.
 * @property {'deploy'|'alert'|'jira_issue'|'runbook_step'|'remediation_action'|'prior_incident'} fact_type
 * @property {string} source_system - Source label, for example bitbucket or jira.
 * @property {string} source_ref - Source-specific reference (commit, issue key, etc.).
 * @property {string} observed_at - ISO-8601 timestamp, captured when the scenario is loaded.
 * @property {string[]} service_scope - Services this fact applies to.
 * @property {string} summary - Human-readable one-line description.
 * @property {number} weight - Hand-assigned demo prior in the range 0-1.
 * @property {string} cluster - Stable ID of the underlying evidence signal, not an environment.
 * @property {string} environment - Deployment environment, for example checkout-prod.
 */

// Every fact type the ledger currently understands. Keep this list explicit so
// an accidental typo in a fixture fails loudly instead of becoming a new type.
export const FACT_TYPES = Object.freeze([
  'deploy',
  'alert',
  'jira_issue',
  'runbook_step',
  'remediation_action',
  'prior_incident',
]);

// One key per fact, plus one index key. The prefix is also used for the
// best-effort orphan sweep after a load or reset.
export const FACT_KEY_PREFIX = 'sentinel:fact:';
export const INDEX_KEY = 'sentinel:index';

// Documented Forge KVS limits:
// https://developer.atlassian.com/platform/forge/limits-kvs-ce/
// - key length: 500 characters
// - value size: 240 KiB (RAW)
// - key format: /^(?!\s+$)[a-zA-Z0-9:._\s-#]+$/
export const MAX_KEY_LENGTH = 500;
export const MAX_STORED_VALUE_BYTES = 240 * 1024;

// Fact IDs are deliberately shorter than the full key limit so the prefix and
// any future namespace cannot push a key over 500 characters.
export const MAX_FACT_ID_LENGTH = 120;

const FACT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const KEY_PATTERN = /^(?!\s+$)[a-zA-Z0-9:._\s-#]+$/;

/**
 * Tunable priors for a future scoring pass.
 *
 * These numbers are NOT truth. They are starting assumptions about how much
 * each signal should count when the team later calibrates a score. A value of
 * 0.30 means "this factor gets 30% of the influence in the first draft", not
 * "this fact is 30% true". Change them when the demo teaches us something.
 *
 * The four influence shares total 0.90; crossClusterPenalty is a separate
 * 0.10 discount, so the full set happens to total 1.00. They are relative
 * starting points, not calibrated probabilities.
 */
export const WEIGHTS = Object.freeze({
  // Time proximity: how strongly a recent observation should outrank an old
  // one. Tune down if stale facts are crowding out the incident window.
  timeProximity: 0.3,

  // Source reliability: how strongly the source's track record should count.
  // This is a prior about sources in general, not proof that a given fact is
  // true. Tune per source once we have real outcome data.
  sourceReliability: 0.25,

  // Service-scope overlap: how strongly shared service_scope values should tie
  // a fact to the incident. Tune down if broad scopes create weak matches.
  scopeOverlap: 0.2,

  // Fact-type relevance: how strongly the type itself should count (for
  // example, an alert usually outranks a runbook step as evidence of impact).
  // This is a prior, not a verdict about any individual fact.
  factTypePrior: 0.15,

  // Cross-cluster penalty: the discount applied when a fact belongs to a
  // different evidence-signal cluster than the hypothesis it supports. This
  // is a prior for "probably unrelated", not proof that the fact is irrelevant.
  crossClusterPenalty: 0.1,
});

function fail(field, message) {
  throw new TypeError(`Invalid fact.${field}: ${message}`);
}

function readNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(field, 'expected a non-empty string');
  }
  return value.trim();
}

function readFactId(value) {
  const id = readNonEmptyString(value, 'fact_id');
  if (id.length > MAX_FACT_ID_LENGTH) {
    fail('fact_id', `must be at most ${MAX_FACT_ID_LENGTH} characters`);
  }
  if (!FACT_ID_PATTERN.test(id)) {
    fail('fact_id', 'may contain only letters, numbers, dots, underscores, and hyphens');
  }
  return id;
}

function readFactType(value) {
  if (!FACT_TYPES.includes(value)) {
    fail(
      'fact_type',
      `expected one of ${FACT_TYPES.join(', ')}; received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function readIsoTimestamp(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('observed_at', 'expected an ISO-8601 timestamp string');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    fail('observed_at', `expected a valid ISO-8601 timestamp; received ${JSON.stringify(value)}`);
  }
  return date.toISOString();
}

function assertIsoTimestamp(value) {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    Number.isNaN(new Date(value).getTime())
  ) {
    fail('observed_at', 'expected a valid ISO-8601 timestamp string');
  }
}

function readServiceScope(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('service_scope', 'expected a non-empty array of service names');
  }
  const scope = value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      fail(`service_scope[${index}]`, 'expected a non-empty string');
    }
    return entry.trim();
  });
  return Array.from(new Set(scope));
}

function readWeight(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail('weight', `expected a finite number between 0 and 1; received ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Checks that a value obeys the documented Forge KVS key constraints.
 * Returns the key so callers can use it inline.
 */
export function assertKeyFitsStorage(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('Invalid storage key: expected a non-empty string.');
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new RangeError(
      `Storage key is ${key.length} characters; the Forge KVS limit is ${MAX_KEY_LENGTH}.`,
    );
  }
  if (!KEY_PATTERN.test(key)) {
    throw new TypeError(`Storage key "${key}" does not match the Forge KVS key format.`);
  }
  return key;
}

/**
 * Checks that a fact's JSON representation fits the documented 240 KiB KVS
 * value limit. Returns the byte count for logging and tests.
 */
export function assertFactFitsStorage(fact) {
  const serialized = JSON.stringify(fact);
  const bytes = new TextEncoder().encode(serialized).length;
  if (bytes > MAX_STORED_VALUE_BYTES) {
    throw new RangeError(
      `Fact ${fact && fact.fact_id ? fact.fact_id : '<unknown>'} is ${bytes} bytes; ` +
        `the Forge KVS value limit is ${MAX_STORED_VALUE_BYTES} bytes (240 KiB).`,
    );
  }
  return bytes;
}

/**
 * Builds the storage key for a fact ID.
 *
 * Example: fact_deploy_root_001 -> sentinel:fact:fact_deploy_root_001
 */
export function factKey(factId) {
  const id = readFactId(factId);
  return assertKeyFitsStorage(`${FACT_KEY_PREFIX}${id}`);
}

/**
 * Extracts and validates the fact ID from a storage key. Used by the
 * best-effort prefix sweep so an unrelated key can never be deleted.
 */
export function factIdFromKey(key) {
  assertKeyFitsStorage(key);
  if (!key.startsWith(FACT_KEY_PREFIX)) {
    throw new TypeError(`Storage key "${key}" is not a Sentinel fact key.`);
  }
  return readFactId(key.slice(FACT_KEY_PREFIX.length));
}

/**
 * Validates a fact without changing it. getLedger uses this on values read from
 * storage, so observed_at is checked rather than recomputed.
 */
export function validateFact(fact) {
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
    throw new TypeError('Invalid fact: expected an object.');
  }
  readFactId(fact.fact_id);
  readFactType(fact.fact_type);
  readNonEmptyString(fact.source_system, 'source_system');
  readNonEmptyString(fact.source_ref, 'source_ref');
  assertIsoTimestamp(fact.observed_at);
  readServiceScope(fact.service_scope);
  readNonEmptyString(fact.summary, 'summary');
  readWeight(fact.weight);
  readNonEmptyString(fact.cluster, 'cluster');
  readNonEmptyString(fact.environment, 'environment');
  assertFactFitsStorage(fact);
  return fact;
}

/**
 * Creates a normalized fact. Extra properties are intentionally dropped so the
 * stored shape stays consistent as the ledger grows.
 */
export function createFact(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Invalid fact: expected an object.');
  }
  const fact = {
    fact_id: readFactId(input.fact_id),
    fact_type: readFactType(input.fact_type),
    source_system: readNonEmptyString(input.source_system, 'source_system'),
    source_ref: readNonEmptyString(input.source_ref, 'source_ref'),
    observed_at: readIsoTimestamp(input.observed_at),
    service_scope: readServiceScope(input.service_scope),
    summary: readNonEmptyString(input.summary, 'summary'),
    weight: readWeight(input.weight),
    cluster: readNonEmptyString(input.cluster, 'cluster'),
    environment: readNonEmptyString(input.environment, 'environment'),
  };
  assertFactFitsStorage(fact);
  return fact;
}
