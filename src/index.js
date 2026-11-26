import Resolver from '@forge/resolver';
import api from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';

import { buildDemoScenario, buildBenchmarkScenarios } from './fixtures.js';
import {
  applyCausalInversionGuard,
  calculateConfidence,
  rankHypotheses,
} from './scoring.js';
import { generateHypotheses as generateHypothesesWithLLM } from './llm.js';
import { proposalKey } from './remediation.js';
import {
  LAST_PROPOSAL_KEY,
  LAST_RUN_KEY,
  createProposalPointer,
  createStoredRun,
  isProposalPointer,
  isStoredRun,
  proposalFromStoredRun,
} from './runStore.js';
import {
  BENCHMARK_LABEL,
  runBenchmark as runBenchmarkWithScenarios,
  summarizeBenchmarkResults,
} from './benchmark.js';
import { buildPostmortem } from './postmortem.js';
import {
  AUDIT_INDEX_KEY,
  AUDIT_INDEX_VERSION,
  auditKey,
  createAuditRecord,
} from './auditLog.js';
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

/**
 * Reads every audit record in index order. getAuditLog and getPostmortem share
 * this path so the decision lineage is exactly the log the user can see.
 */
async function readAuditRecords() {
  const indexRaw = await kvs.get(AUDIT_INDEX_KEY);
  if (
    !indexRaw ||
    typeof indexRaw !== 'object' ||
    !Array.isArray(indexRaw.audit_ids)
  ) {
    return [];
  }

  const ids = indexRaw.audit_ids.filter((id) => typeof id === 'string');
  const stored = await Promise.all(
    ids.map(async (id) => ({ id, record: await kvs.get(auditKey(id)) })),
  );

  return stored
    .filter((entry) => entry.record && typeof entry.record === 'object')
    .map((entry) => entry.record);
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

    // A new ledger invalidates the last scored run. getProposal must not use
    // hypotheses scored against facts that no longer exist.
    await kvs.delete(LAST_RUN_KEY);

    // The latest proposal belonged to the old run. Clearing the pointer keeps
    // getPostmortem from mixing a new ledger with an old decision.
    await kvs.delete(LAST_PROPOSAL_KEY);

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
// Session 3: hypothesis engine (Forge LLM with deterministic fallback)
// ---------------------------------------------------------------------------

resolver.define('generateHypotheses', async () => {
  try {
    const { facts, missing } = await readLedgerFacts();
    warnAboutMissing('generateHypotheses', missing);

    // The generator only sees facts that survive the Causal Inversion Guard, so
    // a recorded remediation action can never be proposed as the cause.
    const filteredFacts = applyCausalInversionGuard(facts);
    const blockedFactIds = facts
      .filter((fact) => fact.fact_type === 'remediation_action')
      .map((fact) => fact.fact_id);
    const generated = await generateHypothesesWithLLM(
      filteredFacts,
      blockedFactIds,
    );

    // Score against the full ledger. Filtering is a generation boundary; the
    // scorer independently blocks remediation citations, rejects citations to
    // facts that do not exist, and treats symptom facts as context rather than
    // causal support.
    const scoredHypotheses = generated.hypotheses.map((hypothesis) => {
      const scored = calculateConfidence(hypothesis, facts);

      return {
        hypothesis_id: hypothesis.hypothesis_id,
        summary: hypothesis.summary,
        confidence: scored.confidence,
        insufficient_evidence: scored.insufficient_evidence,
        corroboration: scored.corroboration,
        causal_cluster_count: scored.causal_cluster_count,
        citations: scored.valid_citations.map((citation) => ({
          fact_id: citation.fact_id,
          stance: citation.stance,
          role: citation.role,
        })),
        valid_citation_ids: citationIds(scored.valid_citations),
        rejected_citation_ids: citationIds(scored.rejected_citations),
        blocked_citation_ids: citationIds(scored.blocked_citations),
      };
    });

    // Rank in the resolver so every client sees the same order and rank.
    const hypotheses = rankHypotheses(scoredHypotheses);

    // Persist the scored run so getProposal uses exactly what the user just
    // saw. A single key is intentional: the latest run is the only run that
    // may produce a decision.
    const storedRun = createStoredRun({
      hypotheses,
      source: generated.source,
      model: generated.model,
      fallback_used: generated.fallback_used,
      fallback_reason: generated.fallback_reason ?? null,
    });
    await kvs.set(LAST_RUN_KEY, storedRun, { keyPolicy: 'OVERRIDE' });

    // A new run invalidates the previous proposal pointer. getPostmortem must
    // not attach an old decision to the new run's hypotheses.
    await kvs.delete(LAST_PROPOSAL_KEY);

    return {
      status: 'SUCCESS',
      source: generated.source,
      model: generated.model,
      fallback_used: generated.fallback_used,
      fallback_reason: generated.fallback_reason ?? null,
      run_created_at: storedRun.created_at,
      count: hypotheses.length,
      hypotheses,
    };
  } catch (error) {
    console.error('generateHypotheses failed:', error);
    throw error;
  }
});

// ---------------------------------------------------------------------------
// Session 6: remediation proposal and audit log
// ---------------------------------------------------------------------------

resolver.define('getProposal', async () => {
  try {
    const { facts, missing } = await readLedgerFacts();
    warnAboutMissing('getProposal', missing);

    // One run, one truth: getProposal must not call the model again. It reads
    // the ranked run saved by generateHypotheses, so the approval card cannot
    // disagree with the hypothesis table the user just saw.
    const storedRun = await kvs.get(LAST_RUN_KEY);
    if (!isStoredRun(storedRun)) {
      return {
        status: 'SUCCESS',
        proposal: null,
        reason: 'Run the Hypothesis Engine first to score hypotheses.',
        needs_run: true,
        source: null,
        model: null,
        fallback_used: false,
        fallback_reason: null,
        run_created_at: null,
        top_hypothesis: null,
      };
    }

    const now = Date.now();
    const { proposal, reason, top_hypothesis: topHypothesis } =
      proposalFromStoredRun(storedRun, { facts, now });

    // Store the proposal so recordDecision can audit it without requiring the
    // client to echo the full proposal back. The proposal is not an audit
    // record; it may be overwritten by the next getProposal call.
    if (proposal) {
      const proposalCreatedAt = new Date(now).toISOString();
      await kvs.set(
        proposalKey(proposal.proposal_id),
        {
          proposal,
          top_hypothesis: topHypothesis,
          created_at: proposalCreatedAt,
        },
        { keyPolicy: 'OVERRIDE' },
      );

      // Point getPostmortem at the proposal that belongs to this stored run.
      // The proposal body stays under its own key; this pointer is only the
      // handoff between the proposal and the postmortem.
      await kvs.set(
        LAST_PROPOSAL_KEY,
        createProposalPointer({
          proposalId: proposal.proposal_id,
          createdAt: proposalCreatedAt,
        }),
        { keyPolicy: 'OVERRIDE' },
      );
    } else {
      // No qualifying proposal means there is no proposal lineage for this run.
      await kvs.delete(LAST_PROPOSAL_KEY);
    }

    return {
      status: 'SUCCESS',
      proposal,
      reason: reason ?? null,
      needs_run: false,
      source: storedRun.source,
      model: storedRun.model,
      fallback_used: storedRun.fallback_used,
      fallback_reason: storedRun.fallback_reason,
      run_created_at: storedRun.created_at,
      top_hypothesis: topHypothesis,
    };
  } catch (error) {
    console.error('getProposal failed:', error);
    return { status: 'ERROR', message: errorMessage(error) };
  }
});

resolver.define('recordDecision', async ({ payload, context } = {}) => {
  try {
    const body = payload && typeof payload === 'object' ? payload : {};
    const proposalId =
      typeof body.proposal_id === 'string' ? body.proposal_id.trim() : '';
    const decision =
      body.decision === 'approve' || body.decision === 'reject'
        ? body.decision
        : null;
    const note = typeof body.note === 'string' ? body.note.trim() : '';

    if (proposalId.length === 0) {
      return { status: 'ERROR', message: 'proposal_id is required.' };
    }
    if (decision === null) {
      return { status: 'ERROR', message: 'decision must be "approve" or "reject".' };
    }

    const stored = await kvs.get(proposalKey(proposalId));
    if (!stored || typeof stored !== 'object' || !stored.proposal) {
      return {
        status: 'ERROR',
        message: 'Proposal not found. Run getProposal first.',
      };
    }

    const decidedBy =
      context &&
      typeof context.accountId === 'string' &&
      context.accountId.trim().length > 0
        ? context.accountId.trim()
        : 'unknown';
    const now = Date.now();
    let auditRecord = null;

    // Append-only: FAIL_IF_EXISTS guarantees a key is never overwritten. If a
    // collision occurs, retry with a fresh suffix.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const suffix = `${now.toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}_${attempt}`;
      auditRecord = createAuditRecord({
        proposal: stored.proposal,
        topHypothesis: stored.top_hypothesis,
        decision,
        note,
        decidedBy,
        now,
        suffix,
      });

      try {
        await kvs.set(auditKey(auditRecord.audit_id), auditRecord, {
          keyPolicy: 'FAIL_IF_EXISTS',
        });
        break;
      } catch (error) {
        if (attempt === 4) {
          throw error;
        }
      }
    }

    const indexRaw = await kvs.get(AUDIT_INDEX_KEY);
    const index =
      indexRaw && typeof indexRaw === 'object' && Array.isArray(indexRaw.audit_ids)
        ? { version: AUDIT_INDEX_VERSION, audit_ids: indexRaw.audit_ids }
        : { version: AUDIT_INDEX_VERSION, audit_ids: [] };

    if (!index.audit_ids.includes(auditRecord.audit_id)) {
      index.audit_ids.push(auditRecord.audit_id);
    }
    await kvs.set(AUDIT_INDEX_KEY, index, { keyPolicy: 'OVERRIDE' });

    return { status: 'SUCCESS', audit: auditRecord };
  } catch (error) {
    console.error('recordDecision failed:', error);
    return { status: 'ERROR', message: errorMessage(error) };
  }
});

resolver.define('getAuditLog', async () => {
  try {
    const audits = await readAuditRecords();
    return { status: 'SUCCESS', audits, count: audits.length };
  } catch (error) {
    console.error('getAuditLog failed:', error);
    return { status: 'ERROR', message: errorMessage(error) };
  }
});

resolver.define('getPostmortem', async () => {
  try {
    const storedRun = await kvs.get(LAST_RUN_KEY);

    // No stored run: return a clear message instead of inventing an incident.
    if (!isStoredRun(storedRun)) {
      const postmortem = buildPostmortem({
        facts: [],
        run: null,
        proposal: null,
        audits: [],
      });
      return {
        status: 'SUCCESS',
        available: false,
        reason: postmortem.reason,
        markdown: postmortem.markdown,
        postmortem,
      };
    }

    const { facts, missing } = await readLedgerFacts();
    warnAboutMissing('getPostmortem', missing);

    // The pointer is written by getProposal. Reading the proposal body here
    // keeps the postmortem's action items and decision lineage aligned with
    // the exact proposal that recordDecision audited.
    const pointer = await kvs.get(LAST_PROPOSAL_KEY);
    let proposal = null;
    if (isProposalPointer(pointer)) {
      const storedProposal = await kvs.get(proposalKey(pointer.proposal_id));
      if (
        storedProposal &&
        typeof storedProposal === 'object' &&
        storedProposal.proposal
      ) {
        proposal = storedProposal.proposal;
      }
    }

    const audits = await readAuditRecords();
    const postmortem = buildPostmortem({
      facts,
      run: storedRun,
      proposal,
      audits,
    });

    return {
      status: 'SUCCESS',
      available: postmortem.available,
      reason: postmortem.reason,
      markdown: postmortem.markdown,
      postmortem,
    };
  } catch (error) {
    console.error('getPostmortem failed:', error);
    return { status: 'ERROR', message: errorMessage(error) };
  }
});

resolver.define('runBenchmark', async ({ payload } = {}) => {
  try {
    const body = payload && typeof payload === 'object' ? payload : {};
    const completed = Array.isArray(body.completed_scenario_ids)
      ? body.completed_scenario_ids.filter((id) => typeof id === 'string')
      : [];
    const completedSet = new Set(completed);
    const scenarios = buildBenchmarkScenarios();

    // Run exactly one pending scenario per resolver invocation. The resolver
    // limit is 25 seconds, and one real model call can use up to 22 seconds
    // (one 15-second attempt plus a retry), so stacking scenarios here would
    // risk a timeout. The UI calls this resolver again with the completed IDs
    // until every scenario has a result.
    const next = scenarios.find(
      (scenario) => !completedSet.has(scenario.id),
    );

    if (!next) {
      return {
        status: 'SUCCESS',
        label: BENCHMARK_LABEL,
        results: [],
        metrics: summarizeBenchmarkResults([]),
        completed_scenario_ids: completed,
        remaining_scenario_ids: [],
        done: true,
      };
    }

    // The benchmark generator is a thin wrapper around the real LLM. Unlike
    // the production hypothesis path, it deliberately passes
    // remediation_action facts to the model so the rollback-trap scenario is
    // observable. It also passes no parser-level blocked IDs: the facts are
    // synthetic, and retaining a remediation citation lets the deterministic
    // scorer block and count it instead of the parser silently dropping it.
    // The production path still filters remediation facts before generation
    // and passes their IDs to the parser. A mock fallback is returned
    // normally; the benchmark marks it "not evaluated" instead of counting it
    // as a model prediction.
    const generate = async (scenario) =>
      generateHypothesesWithLLM(scenario.facts, []);

    const scenarioRun = await runBenchmarkWithScenarios({
      scenarios: [next],
      generate,
    });
    const results = scenarioRun.results;

    const completedIds = [...completed];
    for (const result of results) {
      if (!completedIds.includes(result.scenario_id)) {
        completedIds.push(result.scenario_id);
      }
    }
    const remainingIds = scenarios
      .map((scenario) => scenario.id)
      .filter((id) => !completedIds.includes(id));

    // These metrics cover the result returned by this invocation. The UI
    // merges results from every invocation and recomputes the full summary
    // with summarizeBenchmarkResults.
    return {
      status: 'SUCCESS',
      label: BENCHMARK_LABEL,
      results,
      metrics: summarizeBenchmarkResults(results),
      completed_scenario_ids: completedIds,
      remaining_scenario_ids: remainingIds,
      done: remainingIds.length === 0,
    };
  } catch (error) {
    console.error('runBenchmark failed:', error);
    return { status: 'ERROR', message: errorMessage(error) };
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

    // The scored run belonged to the cleared ledger; remove it so getProposal
    // asks the user to run the engine again.
    await kvs.delete(LAST_RUN_KEY);
    await kvs.delete(LAST_PROPOSAL_KEY);

    return { status: 'SUCCESS', cleared };
  } catch (error) {
    console.error('resetDemoData failed:', error);
    return { status: 'ERROR', message: errorMessage(error) };
  }
});

export const handler = resolver.getDefinitions();
