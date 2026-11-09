import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
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
  ],
};

const HYPOTHESIS_TABLE_HEAD = {
  cells: [
    { key: 'hypothesis', content: 'Hypothesis', isSortable: true },
    { key: 'confidence', content: 'Confidence', isSortable: true },
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

  const cited = validIds.length > 0 ? validIds.join(', ') : 'None';
  const blocked =
    rejectedIds.length > 0
      ? ` (Blocked: ${rejectedIds.length} hallucinated facts)`
      : '';

  return `${cited}${blocked}`;
}

function toHypothesisRows(hypotheses) {
  return hypotheses.map((hypothesis, index) => ({
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
  }));
}

function messageFor(error) {
  return error && error.message ? error.message : String(error);
}

const App = () => {
  const [facts, setFacts] = useState([]);
  const [hypotheses, setHypotheses] = useState([]);
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
    try {
      const result = await invoke('generateHypotheses');
      if (!Array.isArray(result)) {
        throw new Error(
          (result && result.message) ||
            'generateHypotheses did not return scored hypotheses.',
        );
      }
      setHypotheses(result);
      setMessage({
        appearance: 'success',
        title: 'Hypotheses scored',
        text: `Scored ${result.length} hypotheses against the ledger.`,
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
        Scores deterministic mock hypotheses against the ledger. Citations to
        facts that do not exist are rejected as hallucinations.
      </Text>

      <Button
        appearance="primary"
        onClick={handleRunHypotheses}
        isDisabled={isBusy}
      >
        Run Hypothesis Engine
      </Button>
      {isEngineLoading && <Text>Scoring hypotheses…</Text>}

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
