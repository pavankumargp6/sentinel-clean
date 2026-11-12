import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Badge,
  Button,
  DynamicTable,
  SectionMessage,
  Strong,
  Text,
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

function evidenceFor(hypothesis) {
  const validIds = Array.isArray(hypothesis.valid_citation_ids)
    ? hypothesis.valid_citation_ids
    : [];
  const rejectedIds = Array.isArray(hypothesis.rejected_citation_ids)
    ? hypothesis.rejected_citation_ids
    : [];
  const blockedIds = Array.isArray(hypothesis.blocked_citation_ids)
    ? hypothesis.blocked_citation_ids
    : [];

  const cited = validIds.length > 0 ? validIds.join(', ') : 'None';
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

    return {
      key: `hypothesis:${index}`,
      cells: [
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
  const [message, setMessage] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isEngineLoading, setIsEngineLoading] = useState(false);

  const readLedger = async () => {
    const result = await invoke('getLedger');
    if (!result || result.status !== 'SUCCESS') {
      throw new Error(
        (result && result.message) || 'getLedger did not return a ledger.',
      );
    }
    return Array.isArray(result.facts) ? result.facts : [];
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

  const isBusy = isLoading || isEngineLoading;

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
    </>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
