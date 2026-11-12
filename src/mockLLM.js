/**
 * Deterministic fallback for the optional Forge LLM hypothesis generator.
 *
 * There is no network call here. The three hypotheses are fixed so the scoring
 * pipeline and the hallucination guard can be tested repeatably, and so the UI
 * still has useful output when the model is unavailable.
 *
 * @typedef {import('./ledger.js').Fact} Fact
 *
 * @param {Fact[]} filteredFacts - Facts that survived the Causal Inversion
 *   Guard. The mock accepts this context to mirror the model boundary, but its
 *   output is deliberately fixed so tests stay deterministic.
 * @returns {{
 *   hypothesis_id: string,
 *   summary: string,
 *   citations: {
 *     hypothesis_id: string,
 *     fact_id: string,
 *     stance: 'supports'|'contradicts',
 *   }[],
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
      hypothesis_id: 'hypothesis_checkout_v2140',
      summary:
        'The checkout-service v2.14.0 deploy added synchronous tax calculation and caused the checkout latency.',
      citations: [
        {
          hypothesis_id: 'hypothesis_checkout_v2140',
          fact_id: 'fact_deploy_root_001',
          stance: 'supports',
        },
        {
          hypothesis_id: 'hypothesis_checkout_v2140',
          fact_id: 'fact_jira_change_001',
          stance: 'supports',
        },
      ],
    },
    {
      hypothesis_id: 'hypothesis_search_v521',
      summary:
        'The search-service v5.2.1 deploy in search-prod caused the checkout latency.',
      citations: [
        {
          hypothesis_id: 'hypothesis_search_v521',
          fact_id: 'fact_deploy_decoy_001',
          stance: 'supports',
        },
      ],
    },
    {
      hypothesis_id: 'hypothesis_unrecorded_migration',
      summary:
        'An unrecorded database migration caused the checkout latency.',
      citations: [
        {
          hypothesis_id: 'hypothesis_unrecorded_migration',
          fact_id: 'fact_does_not_exist_999',
          stance: 'supports',
        },
      ],
    },
  ];
}
