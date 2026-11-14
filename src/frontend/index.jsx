import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Badge,
  Button,
  CodeBlock,
  DynamicTable,
  SectionMessage,
  Strong,
  Text,
  TextArea,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const TABLE_HEAD = {
  cells: [
    { key: 'type', content: 'Type', isSortable: true },
    { key: 'summary', content: 'Summary', isSortable: true, shouldTruncate: true },
    { key: 'weight', content: 'Weight', isSortable: true },
    { key: 'cluster', content: 'Cluster', isSortable: true },
    { key: 'environment', content: 'Environment', isSortable: true },
  ],
};

const HYPOTHESIS_TABLE_HEAD = {
  cells: [
    { key: 'rank', content: 'Rank', isSortable: true },
    { key: 'hypothesis', content: 'Hypothesis', isSortable: true },
    { key: 'confidence', content: 'Confidence', isSortable: true },
    { key: 'corroboration', content: 'Corroboration', isSortable: true },
    { key: 'status', content: 'Status', isSortable: true },
    {
      key: 'evidence',
      content: 'Evidence Cited',
      isSortable: true,
      shouldTruncate: true,
    },
  ],
};

const EVIDENCE_HEAD = {
  cells: [
    { key: 'fact', content: 'Fact', isSortable: true },
    { key: 'stance', content: 'Stance', isSortable: true },
    { key: 'role', content: 'Role', isSortable: true },
  ],
};

const BLAST_RADIUS_HEAD = {
  cells: [
    { key: 'service', content: 'Service', isSortable: true },
    { key: 'owner', content: 'Owner', isSortable: true },
    {
      key: 'dependents',
      content: 'Dependents',
      isSortable: true,
      shouldTruncate: true,
    },
  ],
};

const AUDIT_HEAD = {
  cells: [
    { key: 'decision', content: 'Decision', isSortable: true },
    {
      key: 'decided_at',
      content: 'Decided At',
      isSortable: true,
      shouldTruncate: true,
    },
    {
      key: 'decided_by',
      content: 'Decided By',
      isSortable: true,
      shouldTruncate: true,
    },
    {
      key: 'proposal_id',
      content: 'Proposal',
      isSortable: true,
      shouldTruncate: true,
    },
    {
      key: 'hypothesis_id',
      content: 'Hypothesis',
      isSortable: true,
      shouldTruncate: true,
    },
    { key: 'confidence', content: 'Confidence', isSortable: true },
    {
      key: 'evidence',
      content: 'Evidence',
      isSortable: true,
      shouldTruncate: true,
    },
    {
      key: 'note',
      content: 'Note',
      isSortable: true,
      shouldTruncate: true,
    },
  ],
};

function toRows(facts) {
  return facts.map((fact) => ({
    key: fact.fact_id,
    cells: [
      { key: `${fact.fact_id}:type`, content: fact.fact_type },
      { key: `${fact.fact_id}:summary`, content: fact.summary },
      { key: `${fact.fact_id}:weight`, content: Number(fact.weight).toFixed(2) },
      { key: `${fact.fact_id}:cluster`, content: fact.cluster },
      { key: `${fact.fact_id}:environment`, content: fact.environment },
    ],
  }));
}

function formatConfidence(value) {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}

function citationLabel(citation) {
  if (!citation || typeof citation.fact_id !== 'string') {
    return null;
  }
  if (citation.role === 'context') {
    return `${citation.fact_id} (context)`;
  }
  if (citation.stance === 'supports' || citation.stance === 'contradicts') {
    return `${citation.fact_id} (${citation.stance})`;
  }
  return citation.fact_id;
}

function evidenceFor(hypothesis) {
  const citations = Array.isArray(hypothesis.citations)
    ? hypothesis.citations
        .map((citation) => citationLabel(citation))
        .filter((label) => label !== null)
    : [];
  const validIds = Array.isArray(hypothesis.valid_citation_ids)
    ? hypothesis.valid_citation_ids
    : [];
  const rejectedIds = Array.isArray(hypothesis.rejected_citation_ids)
    ? hypothesis.rejected_citation_ids
    : [];
  const blockedIds = Array.isArray(hypothesis.blocked_citation_ids)
    ? hypothesis.blocked_citation_ids
    : [];

  const cited =
    citations.length > 0
      ? citations.join(', ')
      : validIds.length > 0
        ? validIds.join(', ')
        : 'None';
  const hallucinationNote =
    rejectedIds.length > 0
      ? ` (Blocked: ${rejectedIds.length} hallucinated facts)`
      : '';
  const guardNote =
    blockedIds.length > 0
      ? ` (Causal guard: ${blockedIds.length} remediation citations blocked)`
      : '';

  return `${cited}${hallucinationNote}${guardNote}`;
}

function toHypothesisRows(hypotheses) {
  return hypotheses.map((hypothesis, index) => {
    const corroboration = Number.isFinite(hypothesis.corroboration)
      ? hypothesis.corroboration
      : 0;
    const rank = Number.isFinite(hypothesis.rank) ? hypothesis.rank : index + 1;

    return {
      key: `hypothesis:${index}`,
      cells: [
        {
          key: `hypothesis:${index}:rank`,
          content: String(rank),
        },
        {
          key: `hypothesis:${index}:summary`,
          content: hypothesis.summary,
        },
        {
          key: `hypothesis:${index}:confidence`,
          content: formatConfidence(hypothesis.confidence),
        },
        {
          key: `hypothesis:${index}:corroboration`,
          content: (
            <Badge appearance={corroboration > 0 ? 'primary' : 'default'}>
              {String(corroboration)}
            </Badge>
          ),
        },
        {
          key: `hypothesis:${index}:status`,
          content: hypothesis.insufficient_evidence
            ? 'Insufficient Evidence'
            : 'Ranked',
        },
        {
          key: `hypothesis:${index}:evidence`,
          content: evidenceFor(hypothesis),
        },
      ],
    };
  });
}

function evidenceRows(citations) {
  if (!Array.isArray(citations) || citations.length === 0) {
    return [];
  }

  return citations.map((citation, index) => ({
    key: `evidence:${citation.fact_id ?? index}`,
    cells: [
      { key: `evidence:${index}:fact`, content: citation.fact_id },
      { key: `evidence:${index}:stance`, content: citation.stance },
      { key: `evidence:${index}:role`, content: citation.role },
    ],
  }));
}

function blastRadiusRows(blastRadius) {
  if (!Array.isArray(blastRadius) || blastRadius.length === 0) {
    return [];
  }

  return blastRadius.map((entry, index) => ({
    key: `blast:${entry.service ?? index}`,
    cells: [
      { key: `blast:${index}:service`, content: entry.service },
      { key: `blast:${index}:owner`, content: entry.owner },
      {
        key: `blast:${index}:dependents`,
        content: Array.isArray(entry.dependents)
          ? entry.dependents.join(', ')
          : '',
      },
    ],
  }));
}

function auditRows(audits) {
  if (!Array.isArray(audits) || audits.length === 0) {
    return [];
  }

  return audits.map((audit, index) => ({
    key: `audit:${audit.audit_id ?? index}`,
    cells: [
      { key: `audit:${index}:decision`, content: audit.decision },
      { key: `audit:${index}:decided_at`, content: audit.decided_at },
      { key: `audit:${index}:decided_by`, content: audit.decided_by },
      { key: `audit:${index}:proposal_id`, content: audit.proposal_id },
      { key: `audit:${index}:hypothesis_id`, content: audit.hypothesis_id },
      {
        key: `audit:${index}:confidence`,
        content: Number.isFinite(audit.confidence_at_decision)
          ? audit.confidence_at_decision.toFixed(2)
          : '0.00',
      },
      {
        key: `audit:${index}:evidence`,
        content: Array.isArray(audit.evidence_fact_ids)
          ? audit.evidence_fact_ids.join(', ')
          : '',
      },
      { key: `audit:${index}:note`, content: audit.note ?? '' },
    ],
  }));
}

function messageFor(error) {
  return error && error.message ? error.message : String(error);
}

function sourceLabel(run) {
  if (!run) {
    return null;
  }
  return run.fallback_used || run.source === 'mock' ? 'Mock (fallback)' : 'LLM';
}

const App = () => {
  const [facts, setFacts] = useState([]);
  const [hypotheses, setHypotheses] = useState([]);
  const [engineRun, setEngineRun] = useState(null);
  const [proposalRun, setProposalRun] = useState(null);
  const [auditLog, setAuditLog] = useState([]);
  const [decision, setDecision] = useState(null);
  const [decisionNote, setDecisionNote] = useState('');
  const [message, setMessage] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isEngineLoading, setIsEngineLoading] = useState(false);
  const [isProposalLoading, setIsProposalLoading] = useState(false);
  const [isDecisionLoading, setIsDecisionLoading] = useState(false);

  const readLedger = async () => {
    const result = await invoke('getLedger');
    if (!result || result.status !== 'SUCCESS') {
      throw new Error(
        (result && result.message) || 'getLedger did not return a ledger.',
      );
    }
    return Array.isArray(result.facts) ? result.facts : [];
  };

  const loadAuditLog = async () => {
    try {
      const result = await invoke('getAuditLog');
      if (!result || result.status !== 'SUCCESS') {
        throw new Error(
          (result && result.message) || 'getAuditLog did not return an audit log.',
        );
      }
      setAuditLog(Array.isArray(result.audits) ? result.audits : []);
    } catch (error) {
      console.warn('getAuditLog failed:', messageFor(error));
    }
  };

  // Load once on mount so a page refresh shows whatever is already in storage.
  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const result = await invoke('getLedger');
        if (!active) {
          return;
        }
        if (!result || result.status !== 'SUCCESS') {
          throw new Error(
            (result && result.message) || 'getLedger did not return a ledger.',
          );
        }
        const nextFacts = Array.isArray(result.facts) ? result.facts : [];
        setFacts(nextFacts);
        setMessage(
          nextFacts.length > 0
            ? {
                appearance: 'information',
                title: 'Ledger loaded',
                text: `${nextFacts.length} fact${
                  nextFacts.length === 1 ? '' : 's'
                } loaded from storage.`,
              }
            : {
                appearance: 'information',
                title: 'Ledger is empty',
                text: 'Click Load demo scenario to write the demo facts.',
              },
        );
      } catch (error) {
        if (!active) {
          return;
        }
        setMessage({
          appearance: 'error',
          title: 'Could not load the ledger',
          text: messageFor(error),
        });
      }
    })();

    loadAuditLog();

    return () => {
      active = false;
    };
  }, []);

  const handleLoad = async () => {
    setIsLoading(true);
    setMessage(null);
    try {
      const loadResult = await invoke('loadDemoScenario');
      if (!loadResult || loadResult.status !== 'SUCCESS') {
        throw new Error(
          (loadResult && loadResult.message) || 'loadDemoScenario did not complete.',
        );
      }
      const nextFacts = await readLedger();
      setFacts(nextFacts);
      setHypotheses([]);
      setEngineRun(null);
      setProposalRun(null);
      setDecision(null);
      setDecisionNote('');
      setMessage({
        appearance: 'success',
        title: 'Demo scenario loaded',
        text: `Wrote ${loadResult.count} facts. The ledger now contains ${nextFacts.length}.`,
      });
    } catch (error) {
      setMessage({
        appearance: 'error',
        title: 'Load failed',
        text: messageFor(error),
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = async () => {
    setIsLoading(true);
    setMessage(null);
    try {
      const resetResult = await invoke('resetDemoData');
      if (!resetResult || resetResult.status !== 'SUCCESS') {
        throw new Error(
          (resetResult && resetResult.message) || 'resetDemoData did not complete.',
        );
      }
      const nextFacts = await readLedger();
      setFacts(nextFacts);
      setHypotheses([]);
      setEngineRun(null);
      setProposalRun(null);
      setDecision(null);
      setDecisionNote('');
      setMessage({
        appearance: 'success',
        title: 'Demo data reset',
        text: `Cleared ${resetResult.cleared} facts and the ledger index. The ledger now contains ${nextFacts.length}.`,
      });
    } catch (error) {
      setMessage({
        appearance: 'error',
        title: 'Reset failed',
        text: messageFor(error),
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleRunHypotheses = async () => {
    setIsEngineLoading(true);
    setMessage(null);
    setEngineRun(null);
    setProposalRun(null);
    setDecision(null);
    setDecisionNote('');
    try {
      const result = await invoke('generateHypotheses');
      if (
        !result ||
        result.status !== 'SUCCESS' ||
        !Array.isArray(result.hypotheses)
      ) {
        throw new Error(
          (result && result.message) ||
            'generateHypotheses did not return scored hypotheses.',
        );
      }

      const run = {
        source: result.source === 'llm' ? 'llm' : 'mock',
        model: typeof result.model === 'string' ? result.model : null,
        fallback_used: Boolean(result.fallback_used),
        fallback_reason:
          typeof result.fallback_reason === 'string'
            ? result.fallback_reason
            : null,
      };

      setHypotheses(result.hypotheses);
      setEngineRun(run);
      setMessage({
        appearance: run.fallback_used ? 'warning' : 'success',
        title: run.fallback_used
          ? 'Hypotheses scored with fallback'
          : 'Hypotheses scored',
        text: `Scored ${result.hypotheses.length} hypotheses with ${sourceLabel(
          run,
        )}.`,
      });
    } catch (error) {
      setMessage({
        appearance: 'error',
        title: 'Hypothesis engine failed',
        text: messageFor(error),
      });
    } finally {
      setIsEngineLoading(false);
    }
  };

  const handleGetProposal = async () => {
    setIsProposalLoading(true);
    setMessage(null);
    setProposalRun(null);
    setDecision(null);
    setDecisionNote('');
    try {
      const result = await invoke('getProposal');
      if (!result || result.status !== 'SUCCESS') {
        throw new Error(
          (result && result.message) || 'getProposal did not complete.',
        );
      }

      setProposalRun(result);
      setMessage({
        appearance: result.proposal ? 'success' : 'warning',
        title: result.proposal ? 'Remediation proposal ready' : 'No proposal',
        text: result.proposal
          ? `Proposed ${result.proposal.action} for ${result.proposal.target}.`
          : result.reason || 'No qualifying hypothesis.',
      });
    } catch (error) {
      setMessage({
        appearance: 'error',
        title: 'Proposal failed',
        text: messageFor(error),
      });
    } finally {
      setIsProposalLoading(false);
    }
  };

  const handleDecision = async (value) => {
    if (!proposalRun || !proposalRun.proposal) {
      return;
    }

    setIsDecisionLoading(true);
    setMessage(null);
    try {
      const result = await invoke('recordDecision', {
        proposal_id: proposalRun.proposal.proposal_id,
        decision: value,
        note: decisionNote,
      });
      if (!result || result.status !== 'SUCCESS') {
        throw new Error(
          (result && result.message) || 'recordDecision did not complete.',
        );
      }

      setDecision(value);
      setMessage({
        appearance: 'success',
        title: `Proposal ${value === 'approve' ? 'approved' : 'rejected'}`,
        text: `Audit record ${result.audit.audit_id} written.`,
      });
      await loadAuditLog();
    } catch (error) {
      setMessage({
        appearance: 'error',
        title: 'Decision failed',
        text: messageFor(error),
      });
    } finally {
      setIsDecisionLoading(false);
    }
  };

  const isBusy =
    isLoading || isEngineLoading || isProposalLoading || isDecisionLoading;

  return (
    <>
      <Strong>Sentinel Fact Ledger</Strong>
      <Text>
        Demo-only evidence for a checkout incident. Loading the scenario writes
        deterministic fact IDs, so loading it again overwrites the same keys
        instead of creating duplicates.
      </Text>

      <Button
        appearance="primary"
        onClick={handleLoad}
        isDisabled={isBusy}
      >
        Load demo scenario
      </Button>
      <Button
        appearance="danger"
        onClick={handleReset}
        isDisabled={isBusy}
      >
        Reset demo data
      </Button>

      {message && (
        <SectionMessage appearance={message.appearance} title={message.title}>
          <Text>{message.text}</Text>
        </SectionMessage>
      )}

      <DynamicTable
        caption="Sentinel facts"
        head={TABLE_HEAD}
        rows={toRows(facts)}
        isLoading={isLoading}
        emptyView="No facts loaded yet. Click Load demo scenario."
      />

      <Strong>Hypothesis Engine</Strong>
      <Text>
        Generates hypotheses with Forge LLM when available, then scores them
        deterministically against the ledger. If the model is unavailable or
        returns unusable JSON, this run falls back to the deterministic mock.
        Citations to facts that do not exist are rejected as hallucinations.
      </Text>

      <Button
        appearance="primary"
        onClick={handleRunHypotheses}
        isDisabled={isBusy}
      >
        Run Hypothesis Engine
      </Button>
      {isEngineLoading && <Text>Generating and scoring hypotheses…</Text>}
      {engineRun && (
        <Text>
          {`Source: ${sourceLabel(engineRun)}${
            engineRun.source === 'llm' && engineRun.model
              ? ` (${engineRun.model})`
              : ''
          }`}
        </Text>
      )}
      {engineRun && engineRun.fallback_used && (
        <SectionMessage appearance="warning" title="LLM fallback used">
          <Text>
            {`This run used the deterministic mock instead of Forge LLM.${
              engineRun.fallback_reason
                ? ` Reason: ${engineRun.fallback_reason}`
                : ''
            }`}
          </Text>
        </SectionMessage>
      )}

      <DynamicTable
        caption="Scored hypotheses"
        head={HYPOTHESIS_TABLE_HEAD}
        rows={toHypothesisRows(hypotheses)}
        isLoading={isEngineLoading}
        emptyView="No hypotheses scored yet. Click Run Hypothesis Engine."
      />

      <Strong>Remediation Proposal</Strong>
      <Text>
        Builds a human-executed proposal from the top-ranked hypothesis. The app
        does not perform rollbacks or restarts; it records the decision in an
        audit log.
      </Text>

      <Button
        appearance="primary"
        onClick={handleGetProposal}
        isDisabled={isBusy}
      >
        Get Remediation Proposal
      </Button>
      {isProposalLoading && <Text>Building proposal…</Text>}

      {proposalRun && !proposalRun.proposal && (
        <SectionMessage appearance="warning" title="No proposal">
          <Text>{proposalRun.reason || 'insufficient evidence'}</Text>
        </SectionMessage>
      )}

      {proposalRun && proposalRun.proposal && (
        <SectionMessage appearance="information" title="Remediation Proposal">
          <Text>
            {`Action: ${proposalRun.proposal.action || 'unknown'} · Target: ${proposalRun.proposal.target || 'unknown'} · Confidence: ${formatConfidence(
              proposalRun.top_hypothesis
                ? proposalRun.top_hypothesis.confidence
                : 0,
            )}`}
          </Text>
          <Text>
            {proposalRun.top_hypothesis
              ? proposalRun.top_hypothesis.summary
              : ''}
          </Text>
          <Text>Evidence cited:</Text>
          <DynamicTable
            caption="Proposal evidence"
            head={EVIDENCE_HEAD}
            rows={evidenceRows(
              proposalRun.top_hypothesis
                ? proposalRun.top_hypothesis.citations
                : [],
            )}
            emptyView="No evidence cited."
          />
          <Text>Blast radius (seeded demo data):</Text>
          <DynamicTable
            caption="Blast radius"
            head={BLAST_RADIUS_HEAD}
            rows={blastRadiusRows(proposalRun.proposal.blast_radius)}
            emptyView="No blast radius data for this target."
          />
          <Text>Human-executed instructions:</Text>
          <CodeBlock
            text={proposalRun.proposal.instructions || ''}
            language="text"
          />
          <Text>Text diff / rollback instructions:</Text>
          <CodeBlock text={proposalRun.proposal.diff || ''} language="text" />
          <Text>Note (optional):</Text>
          <TextArea
            name="decision-note"
            placeholder="Add a note for the audit log"
            value={decisionNote}
            onChange={(event) =>
              setDecisionNote(event && event.target ? event.target.value : '')
            }
            isDisabled={decision !== null || isDecisionLoading}
            minimumRows={3}
          />
          <Button
            appearance="primary"
            onClick={() => handleDecision('approve')}
            isDisabled={decision !== null || isDecisionLoading}
          >
            Approve
          </Button>
          <Button
            appearance="danger"
            onClick={() => handleDecision('reject')}
            isDisabled={decision !== null || isDecisionLoading}
          >
            Reject
          </Button>
          {decision && <Text>{`Decision recorded: ${decision}`}</Text>}
        </SectionMessage>
      )}

      <Strong>Audit Log</Strong>
      <DynamicTable
        caption="Audit log"
        head={AUDIT_HEAD}
        rows={auditRows(auditLog)}
        isLoading={isDecisionLoading}
        emptyView="No decisions recorded yet."
      />
    </>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
