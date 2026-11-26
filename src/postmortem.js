/**
 * Sentinel postmortem builder.
 *
 * Pure and deterministic: this module has no Forge imports, makes no model
 * calls, and performs no writes. Every sentence in the generated Markdown is
 * derived from the stored ledger, the stored scored run, the latest stored
 * proposal, and the append-only audit records passed by the resolver.
 *
 * Remediation actions are response actions, not causes. They stay in the
 * timeline for completeness, but this module never presents one as a root
 * cause, even if a malformed stored run cites one.
 */

// Keep in sync with remediation.MIN_CONFIDENCE. Duplicated here so the
// postmortem module does not need to import the seeded fixture table through
// remediation.js just to read one threshold.
const MIN_CONFIDENCE = 0.5;

const SOURCE_LABELS = Object.freeze({
  llm: 'LLM',
  mock: 'Mock',
});

/**
 * Escapes a value for a Markdown table cell.
 *
 * @param {unknown} value
 * @returns {string}
 */
function cell(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/**
 * Formats confidence consistently with the rest of the UI.
 *
 * @param {unknown} value
 * @returns {string}
 */
function formatConfidence(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(2)
    : '0.00';
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function factMap(facts) {
  const map = new Map();
  if (Array.isArray(facts)) {
    for (const fact of facts) {
      if (isObject(fact) && typeof fact.fact_id === 'string') {
        map.set(fact.fact_id, fact);
      }
    }
  }
  return map;
}

function citationsOf(hypothesis) {
  return isObject(hypothesis) && Array.isArray(hypothesis.citations)
    ? hypothesis.citations
    : [];
}

function topHypothesisOf(run) {
  if (!isObject(run) || !Array.isArray(run.hypotheses) || run.hypotheses.length === 0) {
    return null;
  }
  return (
    run.hypotheses.find(
      (hypothesis) => isObject(hypothesis) && hypothesis.rank === 1,
    ) ||
    run.hypotheses[0] ||
    null
  );
}

function isRemediationCitation(citation, factsById) {
  const fact =
    isObject(citation) && typeof citation.fact_id === 'string'
      ? factsById.get(citation.fact_id)
      : null;
  return Boolean(fact && fact.fact_type === 'remediation_action');
}

function uniqueStrings(values) {
  return Array.from(
    new Set(values.filter((value) => typeof value === 'string' && value.length > 0)),
  );
}

/**
 * Sorts facts by observed_at ascending. Ties are broken by fact_id so the
 * output is stable even when two facts share a timestamp.
 *
 * @param {object[]} facts
 * @returns {object[]}
 */
function sortTimeline(facts) {
  if (!Array.isArray(facts)) {
    return [];
  }

  return facts
    .filter((fact) => isObject(fact) && typeof fact.fact_id === 'string')
    .map((fact) => ({
      fact_id: fact.fact_id,
      fact_type: fact.fact_type ?? 'unknown',
      observed_at: fact.observed_at ?? '',
      summary: fact.summary ?? '',
      environment: fact.environment ?? '',
      service_scope: Array.isArray(fact.service_scope) ? [...fact.service_scope] : [],
      is_remediation: fact.fact_type === 'remediation_action',
    }))
    .sort((left, right) => {
      const byTime = left.observed_at.localeCompare(right.observed_at);
      return byTime !== 0 ? byTime : left.fact_id.localeCompare(right.fact_id);
    });
}

/**
 * Derives a plain-language incident scope from the facts cited by the top
 * hypothesis. This is not a new fact: it only repeats environments and
 * services that are already stored on those facts.
 *
 * @param {object|null} topHypothesis
 * @param {Map<string, object>} factsById
 * @returns {string}
 */
function incidentLabel(topHypothesis, factsById) {
  const citedFacts = citationsOf(topHypothesis)
    .map((citation) =>
      isObject(citation) && typeof citation.fact_id === 'string'
        ? factsById.get(citation.fact_id)
        : null,
    )
    .filter(Boolean);

  const environments = uniqueStrings(
    citedFacts.map((fact) => fact.environment).filter(Boolean),
  );
  const services = uniqueStrings(
    citedFacts.flatMap((fact) =>
      Array.isArray(fact.service_scope) ? fact.service_scope : [],
    ),
  );

  if (environments.length === 0 && services.length === 0) {
    return 'Unknown incident scope (no cited environment or service)';
  }
  if (environments.length === 0) {
    return `Services: ${services.join(', ')}`;
  }
  if (services.length === 0) {
    return `Environment: ${environments.join(', ')}`;
  }
  return `${environments.join(', ')} (${services.join(', ')})`;
}

function sourceLabel(run) {
  const label = SOURCE_LABELS[run && run.source] || 'Unknown';
  const model =
    run && typeof run.model === 'string' && run.model.length > 0
      ? ` (${run.model})`
      : '';
  return `${label}${model}`;
}

function rejectedReason(hypothesis, topHypothesis) {
  const contradictions = uniqueStrings(
    citationsOf(hypothesis)
      .filter((citation) => isObject(citation) && citation.stance === 'contradicts')
      .map((citation) => citation.fact_id),
  );
  const rejected = uniqueStrings(
    Array.isArray(hypothesis && hypothesis.rejected_citation_ids)
      ? hypothesis.rejected_citation_ids
      : [],
  );
  const blocked = uniqueStrings(
    Array.isArray(hypothesis && hypothesis.blocked_citation_ids)
      ? hypothesis.blocked_citation_ids
      : [],
  );

  const parts = [];
  if (contradictions.length > 0) {
    parts.push(`contradicted by ${contradictions.join(', ')}`);
  }
  if (rejected.length > 0) {
    parts.push(`citations rejected as nonexistent: ${rejected.join(', ')}`);
  }
  if (blocked.length > 0) {
    parts.push(
      `citations blocked as remediation actions by the Causal Inversion Guard: ${blocked.join(
        ', ',
      )}`,
    );
  }
  if (parts.length > 0) {
    return parts.join('; ');
  }

  const confidence =
    hypothesis && typeof hypothesis.confidence === 'number'
      ? hypothesis.confidence
      : 0;
  if (hypothesis && hypothesis.insufficient_evidence) {
    return `insufficient evidence (confidence ${formatConfidence(confidence)})`;
  }
  if (confidence < MIN_CONFIDENCE) {
    return `insufficient evidence (confidence ${formatConfidence(confidence)})`;
  }

  const topId =
    topHypothesis && typeof topHypothesis.hypothesis_id === 'string'
      ? topHypothesis.hypothesis_id
      : 'the top hypothesis';
  const topConfidence =
    topHypothesis && typeof topHypothesis.confidence === 'number'
      ? formatConfidence(topHypothesis.confidence)
      : 'unknown';
  return `outranked by ${topId} (${topConfidence} vs ${formatConfidence(
    confidence,
  )})`;
}

/**
 * Selects the audit records that belong to the stored run.
 *
 * The latest proposal pointer identifies the proposal that was built from the
 * stored run, so decisions on that proposal are the exact lineage. A proposal
 * generated again for the same stored run gets a new proposal ID, so decisions
 * on the same top hypothesis after the run was scored are also included. The
 * time bound excludes decisions from earlier runs. If no proposal has been
 * built yet, the same run-window fallback is used on its own.
 *
 * @param {object[]} audits
 * @param {object} run
 * @param {object|null} proposal
 * @returns {object[]}
 */
function decisionLineage(audits, run, proposal) {
  if (!Array.isArray(audits)) {
    return [];
  }

  const topHypothesis = topHypothesisOf(run);
  const proposalId =
    isObject(proposal) && typeof proposal.proposal_id === 'string'
      ? proposal.proposal_id
      : null;
  const topHypothesisId =
    isObject(topHypothesis) && typeof topHypothesis.hypothesis_id === 'string'
      ? topHypothesis.hypothesis_id
      : null;
  const runCreatedAt =
    isObject(run) && typeof run.created_at === 'string' ? run.created_at : null;

  return audits
    .filter((audit) => isObject(audit) && typeof audit.audit_id === 'string')
    .filter((audit) => {
      if (proposalId !== null && audit.proposal_id === proposalId) {
        return true;
      }
      if (topHypothesisId === null || runCreatedAt === null) {
        return false;
      }
      return (
        audit.hypothesis_id === topHypothesisId &&
        typeof audit.decided_at === 'string' &&
        audit.decided_at >= runCreatedAt
      );
    })
    .sort((left, right) => {
      const leftTime = typeof left.decided_at === 'string' ? left.decided_at : '';
      const rightTime = typeof right.decided_at === 'string' ? right.decided_at : '';
      return leftTime.localeCompare(rightTime) || left.audit_id.localeCompare(right.audit_id);
    })
    .map((audit) => ({
      audit_id: audit.audit_id,
      decision: audit.decision ?? 'unknown',
      decided_at: audit.decided_at ?? '',
      decided_by: audit.decided_by ?? 'unknown',
      confidence_at_decision:
        typeof audit.confidence_at_decision === 'number'
          ? audit.confidence_at_decision
          : null,
      evidence_fact_ids: Array.isArray(audit.evidence_fact_ids)
        ? [...audit.evidence_fact_ids]
        : [],
      note: typeof audit.note === 'string' ? audit.note : null,
    }));
}

/**
 * Builds action items from the stored proposal.
 *
 * These are suggestions only. Sentinel never executes a rollback or restart.
 * A review item is added when the proposal's evidence includes a Jira change
 * ticket, because the change record is useful to the humans executing the
 * suggestion.
 *
 * @param {object|null} proposal
 * @param {Map<string, object>} factsById
 * @returns {object[]}
 */
function actionItems(proposal, factsById) {
  if (!isObject(proposal)) {
    return [];
  }

  const target =
    typeof proposal.target === 'string' && proposal.target.length > 0
      ? proposal.target
      : 'the affected service';
  const action =
    typeof proposal.action === 'string' && proposal.action.length > 0
      ? proposal.action
      : 'review';
  const items = [];

  if (action === 'rollback') {
    items.push({
      kind: 'proposal_action',
      action,
      target,
      text: `Roll back ${target} (human-executed; Sentinel does not perform it).`,
    });
  } else if (action === 'restart') {
    items.push({
      kind: 'proposal_action',
      action,
      target,
      text: `Restart ${target} (human-executed; Sentinel does not perform it).`,
    });
  } else {
    items.push({
      kind: 'proposal_action',
      action,
      target,
      text: `Review the proposed ${action} for ${target} (human-executed; Sentinel does not perform it).`,
    });
  }

  const evidenceIds = Array.isArray(proposal.evidence_fact_ids)
    ? proposal.evidence_fact_ids
    : [];
  const seenTickets = new Set();
  for (const factId of evidenceIds) {
    const fact = factsById.get(factId);
    if (!fact || fact.fact_type !== 'jira_issue') {
      continue;
    }
    const ticket =
      typeof fact.source_ref === 'string' && fact.source_ref.length > 0
        ? fact.source_ref
        : null;
    if (ticket === null || seenTickets.has(ticket)) {
      continue;
    }
    seenTickets.add(ticket);
    items.push({
      kind: 'review_change',
      ticket,
      fact_id: fact.fact_id,
      text: `Review change ${ticket} with the change owner before executing.`,
    });
  }

  return items;
}

function rootCauseEvidence(topHypothesis, factsById) {
  const evidence = [];
  const omitted = [];

  for (const citation of citationsOf(topHypothesis)) {
    if (!isObject(citation) || typeof citation.fact_id !== 'string') {
      omitted.push('malformed citation');
      continue;
    }
    if (isRemediationCitation(citation, factsById)) {
      omitted.push(citation.fact_id);
      continue;
    }
    const fact = factsById.get(citation.fact_id);
    if (!fact) {
      omitted.push(citation.fact_id);
      continue;
    }
    evidence.push({
      fact_id: citation.fact_id,
      fact_type: fact.fact_type ?? 'unknown',
      stance: citation.stance ?? 'unknown',
      role: citation.role ?? (fact.fact_type === 'alert' ? 'context' : 'causal'),
      summary: fact.summary ?? '',
    });
  }

  return { evidence, omitted };
}

function timelineMarkdown(timeline) {
  if (timeline.length === 0) {
    return 'No facts are stored for this incident.';
  }

  const lines = [
    '| Observed at | Type | Fact | Summary |',
    '| --- | --- | --- | --- |',
  ];
  for (const fact of timeline) {
    const type = fact.is_remediation
      ? `${fact.fact_type} (response action — never a cause)`
      : fact.fact_type;
    lines.push(
      `| ${cell(fact.observed_at)} | ${cell(type)} | \`${cell(
        fact.fact_id,
      )}\` | ${cell(fact.summary)} |`,
    );
  }
  return lines.join('\n');
}

function rootCauseMarkdown(rootCause) {
  if (!rootCause.top_hypothesis) {
    return 'No scored hypothesis is available in the stored run.';
  }

  const lines = [
    `**${cell(rootCause.top_hypothesis.hypothesis_id)}** — ${cell(
      rootCause.top_hypothesis.summary,
    )}`,
    '',
    `- Confidence: **${formatConfidence(rootCause.top_hypothesis.confidence)}**`,
    `- Source: **${cell(rootCause.source)}**`,
    `- Run scored at: ${cell(rootCause.run_created_at)}`,
  ];

  if (!rootCause.qualified) {
    lines.push(
      '',
      `> No hypothesis reached the ${MIN_CONFIDENCE.toFixed(
        1,
      )} confidence threshold. The top-ranked hypothesis is shown for context; this postmortem does not assert a root cause.`,
    );
  }

  if (rootCause.evidence.length === 0) {
    lines.push('', 'No valid causal evidence was stored for this hypothesis.');
  } else {
    lines.push(
      '',
      '| Fact | Stance | Role | Summary |',
      '| --- | --- | --- | --- |',
    );
    for (const evidence of rootCause.evidence) {
      lines.push(
        `| \`${cell(evidence.fact_id)}\` | ${cell(evidence.stance)} | ${cell(
          evidence.role,
        )} | ${cell(evidence.summary)} |`,
      );
    }
  }

  if (rootCause.omitted_fact_ids.length > 0) {
    lines.push(
      '',
      `Remediation or unresolvable citations were omitted from the root cause: ${rootCause.omitted_fact_ids
        .map((id) => `\`${cell(id)}\``)
        .join(', ')}.`,
    );
  }

  return lines.join('\n');
}

function rejectedMarkdown(rejected) {
  if (rejected.length === 0) {
    return 'No other hypotheses were scored.';
  }
  return rejected
    .map(
      (hypothesis) =>
        `- **${cell(hypothesis.hypothesis_id)}** — ${cell(
          hypothesis.summary,
        )} (confidence **${formatConfidence(
          hypothesis.confidence,
        )}**): ${cell(hypothesis.reason)}`,
    )
    .join('\n');
}

function lineageMarkdown(lineage) {
  if (lineage.length === 0) {
    return 'No decision was recorded for this run.';
  }

  const lines = [
    '| Decision | Decided at | Decided by | Confidence | Evidence | Note |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const audit of lineage) {
    lines.push(
      `| ${cell(audit.decision)} | ${cell(audit.decided_at)} | ${cell(
        audit.decided_by,
      )} | ${formatConfidence(audit.confidence_at_decision)} | ${cell(
        audit.evidence_fact_ids.join(', '),
      )} | ${cell(audit.note ?? '')} |`,
    );
  }
  return lines.join('\n');
}

function actionsMarkdown(items) {
  if (items.length === 0) {
    return 'No action items: no qualifying proposal is stored for this run.';
  }
  return [
    '_These are suggestions derived from the stored proposal. Sentinel does not execute them._',
    '',
    ...items.map((item) => `- [ ] ${item.text}`),
  ].join('\n');
}

/**
 * Builds the Markdown document. Kept separate so the structured object and the
 * Markdown are generated from exactly the same values.
 */
function buildMarkdown(postmortem) {
  const { summary, timeline, root_cause, rejected_hypotheses, decision_lineage, action_items } =
    postmortem;

  return [
    '# Sentinel Incident Postmortem',
    '',
    `_Generated from stored Sentinel data at ${summary.generated_at}. No model call was made._`,
    '',
    '## Summary',
    '',
    `- **Incident:** ${cell(summary.incident)}`,
    `- **Top hypothesis:** ${
      summary.top_hypothesis
        ? `${cell(summary.top_hypothesis.hypothesis_id)} — ${cell(
            summary.top_hypothesis.summary,
          )}`
        : 'none'
    }`,
    `- **Confidence:** ${formatConfidence(summary.confidence)}`,
    `- **Source:** ${cell(summary.source)}`,
    `- **Run scored at:** ${cell(summary.run_created_at)}`,
    '',
    '## Timeline',
    '',
    timelineMarkdown(timeline),
    '',
    'Remediation actions are response actions. They appear in the timeline for completeness and are never treated as a cause.',
    '',
    '## Root Cause',
    '',
    rootCauseMarkdown(root_cause),
    '',
    '## Rejected Hypotheses',
    '',
    rejectedMarkdown(rejected_hypotheses),
    '',
    '## Decision Lineage',
    '',
    lineageMarkdown(decision_lineage),
    '',
    '## Action Items',
    '',
    actionsMarkdown(action_items),
    '',
  ].join('\n');
}

function noRunResult() {
  const reason =
    'Run the Hypothesis Engine first to generate a postmortem. No stored run exists.';
  return {
    available: false,
    reason,
    generated_at: null,
    summary: null,
    timeline: [],
    root_cause: null,
    rejected_hypotheses: [],
    decision_lineage: [],
    action_items: [],
    markdown: [
      '# Sentinel Incident Postmortem',
      '',
      reason,
      '',
    ].join('\n'),
  };
}

/**
 * Builds a postmortem from stored data only.
 *
 * @param {object} params
 * @param {object[]} [params.facts] - Full stored ledger.
 * @param {object|null} [params.run] - Stored scored run from runStore.
 * @param {object|null} [params.proposal] - Latest stored proposal, if any.
 * @param {object[]} [params.audits] - Audit records from the append-only log.
 * @param {string} [params.generated_at] - ISO timestamp for the document.
 * @returns {object} Structured postmortem plus a `markdown` string.
 */
export function buildPostmortem({
  facts = [],
  run = null,
  proposal = null,
  audits = [],
  generated_at = new Date().toISOString(),
} = {}) {
  if (!isObject(run) || !Array.isArray(run.hypotheses) || run.hypotheses.length === 0) {
    return noRunResult();
  }

  const factsById = factMap(facts);
  const timeline = sortTimeline(facts);
  const topHypothesis = topHypothesisOf(run);
  const confidence =
    topHypothesis && typeof topHypothesis.confidence === 'number'
      ? topHypothesis.confidence
      : 0;
  const source = sourceLabel(run);
  const rootEvidence = rootCauseEvidence(topHypothesis, factsById);

  const rejectedHypotheses = run.hypotheses
    .filter(
      (hypothesis) =>
        isObject(hypothesis) &&
        (!topHypothesis ||
          hypothesis.hypothesis_id !== topHypothesis.hypothesis_id),
    )
    .map((hypothesis) => ({
      hypothesis_id:
        typeof hypothesis.hypothesis_id === 'string'
          ? hypothesis.hypothesis_id
          : 'unknown',
      summary: typeof hypothesis.summary === 'string' ? hypothesis.summary : '',
      confidence:
        typeof hypothesis.confidence === 'number' ? hypothesis.confidence : 0,
      reason: rejectedReason(hypothesis, topHypothesis),
    }));

  const summary = {
    generated_at,
    incident: incidentLabel(topHypothesis, factsById),
    top_hypothesis: topHypothesis
      ? {
          hypothesis_id:
            typeof topHypothesis.hypothesis_id === 'string'
              ? topHypothesis.hypothesis_id
              : 'unknown',
          summary:
            typeof topHypothesis.summary === 'string'
              ? topHypothesis.summary
              : '',
        }
      : null,
    confidence,
    source,
    source_type: run.source === 'llm' ? 'llm' : 'mock',
    model: typeof run.model === 'string' ? run.model : null,
    fallback_used: Boolean(run.fallback_used),
    fallback_reason:
      typeof run.fallback_reason === 'string' ? run.fallback_reason : null,
    run_created_at:
      typeof run.created_at === 'string' ? run.created_at : '',
  };

  const rootCause = {
    top_hypothesis: summary.top_hypothesis,
    confidence,
    qualified: confidence >= MIN_CONFIDENCE,
    source,
    run_created_at: summary.run_created_at,
    evidence: rootEvidence.evidence,
    omitted_fact_ids: rootEvidence.omitted,
  };

  const lineage = decisionLineage(audits, run, proposal);
  const actions = actionItems(proposal, factsById);

  const postmortem = {
    available: true,
    reason: null,
    generated_at,
    summary,
    timeline,
    root_cause: rootCause,
    rejected_hypotheses: rejectedHypotheses,
    decision_lineage: lineage,
    action_items: actions,
  };

  postmortem.markdown = buildMarkdown(postmortem);
  return postmortem;
}
