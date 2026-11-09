/**
 * Deterministic stand-in for the future LLM hypothesis generator.
 *
 * There is no network call here. The three hypotheses are fixed so the scoring
 * pipeline and the hallucination guard can be tested repeatably.
 *
 * @typedef {import('./ledger.js').Fact} Fact
 *
 * @param {Fact[]} filteredFacts - Facts that survived the Causal Inversion
 *   Guard. The mock accepts this context to mirror the future model boundary,
 *   but its output is deliberately fixed so tests stay deterministic.
 * @returns {{
 *   summary: string,
 *   citations: { fact_id: string, stance: 'supports'|'contradicts' }[],
 * }[]} Exactly three mock hypotheses.
 */
export function generateMockHypotheses(filteredFacts) {
  if (!Array.isArray(filteredFacts)) {
    throw new TypeError(
      'generateMockHypotheses expects an array of filtered facts.',
    );
  }

  return [
    {
      summary: 'Deploy #482 caused the latency due to cache TTL.',
      citations: [
        { fact_id: 'fact_deploy_root_001', stance: 'supports' },
        { fact_id: 'fact_jira_change_001', stance: 'supports' },
      ],
    },
    {
      summary: 'Deploy #481 in search-service caused the latency.',
      citations: [{ fact_id: 'fact_deploy_decoy_001', stance: 'supports' }],
    },
    {
      summary: 'A rogue database migration caused the issue.',
      citations: [{ fact_id: 'fact_does_not_exist_999', stance: 'supports' }],
    },
  ];
}
