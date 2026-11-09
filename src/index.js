import Resolver from '@forge/resolver';
import api from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';

import { buildDemoScenario } from './fixtures.js';
import { applyCausalInversionGuard, calculateConfidence } from './scoring.js';
import { generateMockHypotheses } from './mockLLM.js';
import {
  FACT_KEY_PREFIX,
  INDEX_KEY,
  MAX_STORED_VALUE_BYTES,
  assertKeyFitsStorage,
  factIdFromKey,
  factKey,
  validateFact,
} from './ledger.js';

const resolver = new Resolver();

// The index is versioned so a future shape change cannot be silently
// misinterpreted by an older deployment.
const INDEX_VERSION = 1;
const QUERY_PAGE_SIZE = 100;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Reads the ledger index. This is the authoritative list of fact IDs.
 *
 * A missing index means "empty ledger". A malformed index is an error: the
 * caller should reset rather than guess which keys belong to Sentinel.
 */
async function readFactIds() {
  const stored = await kvs.get(INDEX_KEY);
  if (stored === undefined || stored === null) {
    return [];
  }
  if (typeof stored !== 'object' || !Array.isArray(stored.fact_ids)) {
    throw new Error(
      `Ledger index "${INDEX_KEY}" is malformed; run resetDemoData and load the demo again.`,
    );
  }
  if (stored.version !== INDEX_VERSION) {
    throw new Error(
      `Ledger index version ${JSON.stringify(stored.version)} is not supported by this build.`,
    );
  }
  return stored.fact_ids.map((id) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('Ledger index contains an invalid fact id.');
    }
    return id;
  });
}

/**
 * Cleanup-tolerant index read. Load and reset must still be able to repair a
 * half-written index, so they log and continue instead of failing closed.
 */
async function readFactIdsForCleanup(operation) {
  try {
    return await readFactIds();
  } catch (error) {
    console.warn(`${operation}: ignoring unreadable ledger index:`, errorMessage(error));
    return [];
  }
}

/**
 * Rebuilds the index from the authoritative in-memory set of fact IDs. The
 * timestamp is informational; readers never use it to recompute fact times.
 */
async function writeIndex(factIds) {
  const uniqueIds = Array.from(new Set(factIds));
  const index = {
    version: INDEX_VERSION,
    fact_ids: uniqueIds,
    rebuilt_at: new Date().toISOString(),
  };

  assertKeyFitsStorage(INDEX_KEY);
  const bytes = jsonBytes(index);
  if (bytes > MAX_STORED_VALUE_BYTES) {
    throw new RangeError(
      `Ledger index is ${bytes} bytes; the Forge KVS value limit is ` +
        `${MAX_STORED_VALUE_BYTES} bytes (240 KiB).`,
    );
  }

  await kvs.set(INDEX_KEY, index, { keyPolicy: 'OVERRIDE' });
  return index;
}

/**
 * Lists every stored Sentinel fact key using the documented prefix query.
 *
 * KVS queries are eventually consistent, so this is a best-effort orphan sweep,
 * not the primary read path. getLedger always follows the index.
 */
async function listStoredFactIds() {
  const ids = new Set();
  let cursor;

  do {
    let query = kvs
      .query()
      .where('key', WhereConditions.beginsWith(FACT_KEY_PREFIX))
      .limit(QUERY_PAGE_SIZE);

    if (cursor) {
      query = query.cursor(cursor);
    }

    const page = await query.getMany();
    for (const result of page.results || []) {
      ids.add(factIdFromKey(result.key));
    }
    cursor = page.nextCursor;
  } while (cursor);

  return Array.from(ids);
}

/**
 * Reads and validates every indexed fact. getLedger and generateHypotheses
 * share this path so both operate on the same stored view.
 *
 * Missing values are reported to the caller rather than treated as fatal, which
 * preserves the existing getLedger behavior for a partially written ledger.
 */
async function readLedgerFacts() {
  const ids = await readFactIds();

  // Reads are independent; fetch them in parallel. The index order is kept
  // when assembling the response.
  const stored = await Promise.all(
    ids.map(async (id) => ({ id, fact: await kvs.get(factKey(id)) })),
  );

  const facts = [];
  const missing = [];
  for (const entry of stored) {
    if (entry.fact === undefined) {
      missing.push(entry.id);
      continue;
    }
    // Validate the stored value without normalizing observed_at. This catches
    // corruption while ensuring reads never recompute fact times.
    validateFact(entry.fact);
    facts.push(entry.fact);
  }

  return { facts, missing };
}

function warnAboutMissing(operation, missing) {
  if (missing.length > 0) {
    console.warn(
      `${operation}: ${missing.length} indexed fact(s) missing from storage:`,
      missing.join(', '),
    );
  }
}

/**
 * Maps citations to a de-duplicated list of fact IDs for the UI response.
 */
function citationIds(citations) {
  const ids = citations
    .map((citation) =>
      citation && typeof citation.fact_id === 'string' ? citation.fact_id : null,
    )
    .filter((id) => id !== null);

  return Array.from(new Set(ids));
}

// ---------------------------------------------------------------------------
// Existing verified handler: do not change its behavior.
// ---------------------------------------------------------------------------

resolver.define('testTwgRead', async () => {
  try {
    const response = await api.asUser().requestTeamworkGraph({
      query: `query { __typename }`
    });
    return { status: 'SUCCESS', data: response };
  } catch (error) {
    return { status: 'ERROR', message: error.message };
  }
});

// ---------------------------------------------------------------------------
// Session 2: fact ledger handlers
// ---------------------------------------------------------------------------

resolver.define('loadDemoScenario', async () => {
  try {
    // Capture "now" once for the whole scenario. The resulting ISO strings are
    // written to KVS below; getLedger reads them back verbatim.
    const facts = buildDemoScenario();

    if (!Array.isArray(facts) || facts.length === 0) {
      throw new Error('Demo scenario produced no facts.');
    }

    // Validate the whole scenario before touching storage so a bad fixture
    // cannot leave a partially written ledger.
    for (const fact of facts) {
      validateFact(fact);
    }

    const newIds = new Set(facts.map((fact) => fact.fact_id));
    if (newIds.size !== facts.length) {
      throw new Error('Demo scenario contains duplicate fact_id values.');
    }

    const previousIds = await readFactIdsForCleanup('loadDemoScenario');
    const staleIds = previousIds.filter((id) => !newIds.has(id));

    // One deterministic key per fact. Re-running the load overwrites the same
    // keys, so it cannot create duplicates.
    for (const fact of facts) {
      await kvs.set(factKey(fact.fact_id), fact, { keyPolicy: 'OVERRIDE' });
    }

    // Remove facts that belonged to an older version of the demo scenario.
    for (const id of staleIds) {
      await kvs.delete(factKey(id));
    }

    // Rebuild the index last. If any write above failed, the previous index is
    // still intact and the next load retries from a known set of keys.
    const index = await writeIndex(facts.map((fact) => fact.fact_id));

    // Best-effort sweep for keys left behind by an earlier half-failed run.
    // Never delete a key that belongs to the current scenario.
    let sweptOrphans = 0;
    try {
      const storedIds = await listStoredFactIds();
      for (const id of storedIds) {
        if (!newIds.has(id)) {
          await kvs.delete(factKey(id));
          sweptOrphans += 1;
        }
      }
    } catch (sweepError) {
      console.warn(
        'loadDemoScenario: orphan sweep skipped:',
        errorMessage(sweepError),
      );
    }

    return {
      status: 'SUCCESS',
      count: facts.length,
      fact_ids: index.fact_ids,
      swept_orphans: sweptOrphans,
    };
  } catch (error) {
    console.error('loadDemoScenario failed:', error);
    return { status: 'ERROR', message: errorMessage(error) };
  }
});

resolver.define('getLedger', async () => {
  try {
    const { facts, missing } = await readLedgerFacts();
    warnAboutMissing('getLedger', missing);

    return {
      status: 'SUCCESS',
      facts,
      count: facts.length,
      missing_count: missing.length,
    };
  } catch (error) {
    console.error('getLedger failed:', error);
    return { status: 'ERROR', message: errorMessage(error) };
  }
});

// ---------------------------------------------------------------------------
// Session 3: deterministic hypothesis engine
// ---------------------------------------------------------------------------

resolver.define('generateHypotheses', async () => {
  try {
    const { facts, missing } = await readLedgerFacts();
    warnAboutMissing('generateHypotheses', missing);

    // The generator only sees facts that survive the Causal Inversion Guard, so
    // a recorded remediation action can never be proposed as the cause.
    const filteredFacts = applyCausalInversionGuard(facts);
    const hypotheses = generateMockHypotheses(filteredFacts);

    // Score against the full ledger. Filtering is a generation boundary, not a
    // citation-validation loophole: a hypothesis that cites a remediation fact
    // can still be scored, but a citation to a fact that does not exist is
    // rejected as a hallucination.
    return hypotheses.map((hypothesis) => {
      const scored = calculateConfidence(hypothesis, facts);

      return {
        summary: hypothesis.summary,
        confidence: scored.confidence,
        insufficient_evidence: scored.insufficient_evidence,
        valid_citation_ids: citationIds(scored.valid_citations),
        rejected_citation_ids: citationIds(scored.rejected_citations),
      };
    });
  } catch (error) {
    console.error('generateHypotheses failed:', error);
    throw error;
  }
});

resolver.define('resetDemoData', async () => {
  try {
    const indexedIds = await readFactIdsForCleanup('resetDemoData');

    // Include any orphan keys the prefix query can still see. This makes reset
    // a true clear even after an earlier half-failed load.
    let storedIds = [];
    try {
      storedIds = await listStoredFactIds();
    } catch (sweepError) {
      console.warn(
        'resetDemoData: prefix sweep skipped:',
        errorMessage(sweepError),
      );
    }

    const allIds = Array.from(new Set([...indexedIds, ...storedIds]));
    let cleared = 0;

    for (const id of allIds) {
      let key;
      try {
        key = factKey(id);
      } catch (keyError) {
        // An invalid ID cannot be a well-formed Sentinel key; skip it rather
        // than letting it block the rest of the reset.
        console.warn(
          `resetDemoData: skipping invalid fact id "${id}":`,
          errorMessage(keyError),
        );
        continue;
      }

      // A real KVS failure propagates so we do not delete the index and leave
      // an orphan behind. The user can retry the reset.
      await kvs.delete(key);
      cleared += 1;
    }

    // Delete the index last. If a delete above failed, the index is still
    // present so another reset can find the remaining keys.
    await kvs.delete(INDEX_KEY);

    return { status: 'SUCCESS', cleared };
  } catch (error) {
    console.error('resetDemoData failed:', error);
    return { status: 'ERROR', message: errorMessage(error) };
  }
});

export const handler = resolver.getDefinitions();
