# Sentinel Verification Log

## 1. Teamwork Graph Read as User
- **Date:** Nov 6, 2026
- **Test:** Execute a minimal GraphQL query via `api.asUser().requestTeamworkGraph()` from a UI Kit 2 Global Page.
- **Result:** PASS
- **Raw Output:** { "status": "SUCCESS", "data": {} }
- **Notes:** UI renders, frontend-to-backend bridge works, and TWG API accepts the `read:graph:issue:jira` scope and authenticates the user context.

## 2. Fact ledger, demo fixtures, and storage (Session 2)
- **Date:** Nov 9, 2026
- **Storage decision:** `@forge/kvs` 2.1.1 with scope `storage:app`.
  - Current docs (updated Aug 21, 2026) document `@forge/kvs` as the Key-Value Store package and require `storage:app`: https://developer.atlassian.com/platform/forge/storage-reference/kvs-api/
  - `@forge/storage` 2.0.3 exists on npm but is not documented as an app-facing API; it was not used.
- **Changes:**
  - Added `src/ledger.js`: Fact typedef, validation, storage-key helpers, and `WEIGHTS` priors (no scoring).
  - Added `src/fixtures.js`: one checkout incident with 6 facts and deterministic IDs.
  - Added `loadDemoScenario`, `getLedger`, and `resetDemoData` to `src/index.js`; kept `testTwgRead` unchanged and kept the manifest handler at `index.handler`.
  - Updated `src/frontend/index.jsx` with Load/Reset buttons, a success/error message area, mount-time ledger loading, and a `DynamicTable`.
  - Added `storage:app` to `manifest.yml`.
  - Added `@forge/kvs` `^2.1.1` to `package.json` and the lockfile.

### Local checks (run before deploy)
- `npm install @forge/kvs`: PASS — 2.1.1 installed. npm reported peer-dependency warnings and 18 vulnerabilities inherited from the existing UI Kit dependency tree; no audit fix was applied.
- Pure-JS ledger verification (Node 22.23.4): PASS
  - 6 facts with unique deterministic IDs.
  - Alert, root deploy, decoy deploy, Jira change, runbook step, and remediation action are present.
  - Decoy deploy is in a different cluster; the Jira change ticket matches the root deploy cluster.
  - `observed_at` is fixed relative to one captured `now`; a later build keeps the IDs but refreshes the times.
  - Schema rejects bad weight/type/scope/timestamp; fact and index values fit Forge KVS limits.
- Manifest YAML parse: PASS — runtime `nodejs24.x`, handler `index.handler`, scopes `["read:jira-work","read:graph:issue:jira","storage:app"]`.
- `node --check` (ESM mode) for `src/ledger.js`, `src/fixtures.js`, `src/index.js`: PASS.
- `npx eslint src/index.js src/ledger.js src/fixtures.js src/frontend/index.jsx`: PASS (exit 0).

### Forge checks
- `forge lint`: **UNVERIFIED** — the CLI is not logged in on this machine.
  - Exact output:
    ```
    Error: Not logged in. If a local keychain is available, run forge login, otherwise set environment variables before trying again. See https://go.atlassian.com/dac/platform/forge/getting-started/#log-in-with-an-atlassian-api-token for more.
    ```
- `forge deploy --non-interactive -e development`: **UNVERIFIED** — blocked by the same auth gate.
  - Exact output:
    ```
    Error: Not logged in. If a local keychain is available, run forge login, otherwise set environment variables before trying again. See https://go.atlassian.com/dac/platform/forge/getting-started/#log-in-with-an-atlassian-api-token for more.
    ```
- `forge install --upgrade`: **UNVERIFIED** — not run; requires a successful deploy and login.

### UI acceptance (not yet verified)
- **UNVERIFIED** — requires deploy + install + browser test:
  - Click Load: facts appear in the DynamicTable.
  - Click Load again: no duplicates.
  - Click Reset: the list empties.
  - Refresh: data persists after Load; stays empty after Reset.
- `DynamicTable` is exported by the installed `@forge/react` 12.4.0-next.3 (confirmed in `node_modules/@forge/react/out/components/index.js`) and matches the documented `head`/`rows` shape. Runtime rendering is **UNVERIFIED** until deployed.
- If `DynamicTable` fails at runtime, the fallback is a simple `List`/`ListItem` view; it was not implemented because the documented component is present and no runtime failure has been observed.

### Commands to finish verification
```bash
cd ~/sentinel-clean
source ~/.nvm/nvm.sh && nvm use 22.23.4
forge login
npm install
forge lint
forge deploy --non-interactive -e development
forge install --upgrade
```
Notes:
- `forge login` is interactive; complete it in your terminal.
- The new `storage:app` scope requires `forge install --upgrade` after deploy.
- The CLI requires Node `^22.23.4 || ^24.22.1 || >=26.12.1`. This machine's default Node was 22.22.1, so the commands switch to 22.23.4 via nvm.
- `forge install --upgrade` may prompt for site/product; those prompts were intentionally left to the CLI.

### Resolver logic against an in-memory KVS mock
- **PASS** (local only; not a Forge runtime test)
  - Empty ledger -> `getLedger` returns 0 facts.
  - `loadDemoScenario` writes 6 facts + 1 index key; `getLedger` returns 6 unique facts.
  - A second load keeps the store at 7 keys; it overwrites the same deterministic keys and does not duplicate them.
  - `observed_at` values are stored on write and are unchanged by a later read.
  - A simulated orphan fact key is removed by the next load and by reset.
  - Reset clears all 6 facts and the index; a reset with only an orphan key also clears it.
  - `testTwgRead` still returns `{ status: "SUCCESS" }` with the mock API.
- This mock test exercises the resolver algorithm only. Real `@forge/kvs` behavior, deployment, and UI rendering remain **UNVERIFIED**.

## 3. Hypothesis engine and deterministic scoring (Session 3)
- **Date:** Nov 9, 2026
- **Scope:** mocked hypotheses only. No external AI API call, and no Confluence or Bitbucket writes.
- **Changes:**
  - Added `src/scoring.js` (pure JS, no Forge imports):
    - `applyCausalInversionGuard(facts)` returns a new array without `remediation_action` facts.
    - `calculateConfidence(hypothesis, allFacts)` rejects citations whose `fact_id` is absent from the ledger.
    - Valid citations are split into `supports` and `contradicts`, grouped by `cluster`, and only the maximum weight per cluster is summed.
    - Confidence is clamped to `[0, 1]`; `insufficient_evidence` is based on total support weight `< 0.2`.
  - Added `src/mockLLM.js`:
    - `generateMockHypotheses(filteredFacts)` returns exactly three fixed hypotheses (strong support, decoy support, hallucination).
  - Updated `src/index.js`:
    - Added `generateHypotheses`, which reads the ledger, applies the guard before mock generation, scores every hypothesis against the full ledger, and returns an array of `{ summary, confidence, insufficient_evidence, valid_citation_ids, rejected_citation_ids }`.
    - Extracted `readLedgerFacts()` so `getLedger` and `generateHypotheses` read the same stored view; `getLedger` behavior is unchanged.
  - Updated `src/frontend/index.jsx`:
    - Added the primary `"Run Hypothesis Engine"` button and a second `DynamicTable` with `Hypothesis`, `Confidence`, `Status`, and `Evidence Cited`.
    - `Status` renders `"Insufficient Evidence"` or `"Ranked"`.
    - Evidence joins valid citation IDs and appends `" (Blocked: X hallucinated facts)"` when citations were rejected.
    - The hypothesis table and a text label show a loading state while the resolver runs.
    - Loading or resetting the demo clears prior scored hypotheses.

### Local checks
- Pure-JS scoring and mock generator test (Node 22.23.4): **PASS**
  - Guard removed exactly 1 of the 6 demo facts (the `remediation_action`) and did not mutate the source array.
  - Mock generator returned exactly 3 hypotheses with the required summaries and citation IDs.
  - Hypothesis A: confidence `0.88`, `insufficient_evidence: false`, valid citations `fact_deploy_root_001`, `fact_jira_change_001`, no rejected citations.
    - Both citations are in `checkout-prod`, so only the maximum weight (`0.88`) counts; the Jira weight (`0.76`) is not double-counted.
  - Hypothesis B: confidence `0.28`, `insufficient_evidence: false`, valid citation `fact_deploy_decoy_001`.
  - Hypothesis C: confidence `0`, `insufficient_evidence: true`, valid citations `[]`, rejected citation `fact_does_not_exist_999`.
  - Additional assertions passed: same-cluster maximum, different-cluster summation, contradiction subtraction, clamp at 0/1, strict `< 0.2` abstention threshold, and rejection of citations to unknown facts.
- Resolver pipeline against an in-memory KVS mock: **PASS** (local only; not a Forge runtime test)
  - Seeded 6 facts plus the ledger index.
  - `generateHypotheses` returned the exact three scored objects above, including `rejected_citation_ids: ["fact_does_not_exist_999"]` for Hypothesis C.
  - `getLedger` still returned all 6 facts, including the remediation action, confirming that the guard is applied to generation but scoring uses the full ledger.
- `node --check` for `src/index.js`, `src/scoring.js`, and `src/mockLLM.js` (Node 22.23.4): **PASS**
- `npx eslint src/index.js src/scoring.js src/mockLLM.js src/frontend/index.jsx src/ledger.js src/fixtures.js`: **PASS** (exit 0)

### Forge checks
- `forge lint`, `forge deploy`, and `forge install --upgrade`: **UNVERIFIED** — still blocked by the Forge CLI authentication gate documented in Session 2; not re-run in this session.
- No deployment or scope update was performed.

### UI acceptance (not yet verified)
- **UNVERIFIED** — requires deploy + install + browser test:
  - Click `Run Hypothesis Engine`: three rows appear.
  - Hypothesis A shows confidence `0.88`, status `Ranked`, evidence `fact_deploy_root_001, fact_jira_change_001`.
  - Hypothesis B shows confidence `0.28`, status `Ranked`, evidence `fact_deploy_decoy_001`.
  - Hypothesis C shows confidence `0.00`, status `Insufficient Evidence`, evidence `None (Blocked: 1 hallucinated facts)`.
  - The hypothesis table shows its loading state while the resolver is running.
- `DynamicTable` and `Button` are imported from `@forge/react`; no external AI, Confluence, or Bitbucket calls were added.

### Commands to finish verification
```bash
cd ~/sentinel-clean
source ~/.nvm/nvm.sh && nvm use 22.23.4
forge login
forge lint
forge deploy --non-interactive -e development
forge install --upgrade
```
Notes:
- `forge login` is interactive; complete it in your terminal.
- The `storage:app` scope was added in Session 2, so `forge install --upgrade` is still required after deploy.
- After install, run the UI acceptance checklist above.

## 4. Audit, cluster semantics, and unit tests (Session 3 follow-up)
- **Date:** Nov 9, 2026
- **Audit note:** `git log` contains one commit, `7070852 Session 2: ledger, fixtures, KVS storage, DynamicTable UI`. The working tree was clean before this audit, and that commit already contains `src/scoring.js`, `src/mockLLM.js`, and the hypothesis UI. No later commit existed.
- **Mismatches found and fixed:**
  - The Fact schema had no required `environment` field. Added it to the typedef, `createFact`, `validateFact`, all six fixtures, and the facts table.
  - `cluster` was storing environment IDs (`checkout-prod`, `search-prod`) and was documented as an environment. It now stores evidence-signal IDs:
    - `fact_alert_001`: `symptom-checkout-latency`
    - `fact_deploy_root_001`: `change-checkout-v2.14.0`
    - `fact_jira_change_001`: `change-checkout-v2.14.0`
    - `fact_deploy_decoy_001`: `change-search-v5.2.1`
    - `fact_runbook_step_001`: `runbook-checkout`
    - `fact_remediation_001`: `remediation-restart-checkout`
  - Citation records lacked `hypothesis_id`. Added it to the citation/hypothesis typedefs and every mock citation.
  - `calculateConfidence` accepted a citation to a `remediation_action` fact. It now blocks those citations through the Causal Inversion Guard and returns them separately in `blocked_citations`; unknown fact IDs remain in `rejected_citations`.
  - Corroboration was not reported. Added `corroboration` as the count of distinct `source_system` values among valid supporting citations. It is never used as a multiplier.
  - `generateHypotheses` now returns `hypothesis_id`, `corroboration`, and `blocked_citation_ids` in addition to the existing fields.
  - The hypothesis table now has a `Corroboration` badge column. The facts table now has an `Environment` column.
- **Unchanged:** `testTwgRead`, `loadDemoScenario`, `getLedger`, and `resetDemoData` logic. `testTwgRead` was not edited. Load/reset still use deterministic fact IDs and the same KVS keys. No manifest scope changes were made.
- **Storage note:** because `environment` is now required, facts stored by the previous build must be reloaded (or reset and reloaded) before `getLedger` will validate them. `loadDemoScenario` overwrites the same deterministic keys.

### Unit tests
- Added `test/scoring.test.js` using `node:test`; added `"test": "node --test"` to `package.json`.
- `npm test` (Node 22.23.4): **PASS** — 7 tests, 7 passed, 0 failed.
  - Deploy + Jira in `change-checkout-v2.14.0` count once (confidence `0.88`, not `1`).
  - `remediation_action` citation is blocked.
  - Unknown `fact_id` is rejected/ignored.
  - Zero valid citations score `0` and set `insufficient_evidence: true`.
  - Contradicting weight above supporting weight clamps confidence to `0`.
  - Root-cause hypothesis (`0.88`, corroboration `2`) outranks the decoy (`0.28`, corroboration `1`).
  - Fixtures use the required signal clusters and environments; reloading preserves deterministic IDs; `createFact` rejects a missing environment.
- Resolver pipeline against the in-memory KVS mock: **PASS** (local only)
  - `generateHypotheses` returned the same three scores with `hypothesis_id`, `corroboration`, `rejected_citation_ids`, and `blocked_citation_ids`.
  - `getLedger` returned all 6 facts with environments, including the remediation action.
- `node --check` for `src/ledger.js`, `src/fixtures.js`, `src/scoring.js`, `src/mockLLM.js`, and `src/index.js`: **PASS**
- `npx eslint` for the changed JS/JSX files plus the test: **PASS**
- `npm run lint`: **PASS**
- Node emitted a benign `MODULE_TYPELESS_PACKAGE_JSON` warning during tests. No `"type": "module"` was added because that could affect Forge packaging; it is unrelated to the test result.

### Forge checks
- `forge lint`: **UNVERIFIED** — blocked by CLI authentication.
  - Exact output:
    ```
    Error: Not logged in. If a local keychain is available, run forge login, otherwise set environment variables before trying again. See https://go.atlassian.com/dac/platform/forge/getting-started/#log-in-with-an-atlassian-api-token for more.

    Rerunning the command with --verbose may give more details.
    ```
- `forge deploy`: **UNVERIFIED** — not run; requires Forge login and was not attempted to avoid an unintended deployment.
- No manifest scopes changed, so `forge deploy` should not need `--approve`.

### UI acceptance (not yet verified)
- **UNVERIFIED** — requires deploy + install + browser test:
  - Facts table shows `Environment` (`checkout-prod` / `search-prod`).
  - Hypothesis table shows a numeric `Corroboration` badge.
  - Root hypothesis: confidence `0.88`, corroboration `2`, evidence `fact_deploy_root_001, fact_jira_change_001`.
  - Decoy: confidence `0.28`, corroboration `1`, evidence `fact_deploy_decoy_001`.
  - Hallucination: confidence `0.00`, `Insufficient Evidence`, corroboration `0`, evidence `None (Blocked: 1 hallucinated facts)`.

### Commands to finish verification
```bash
cd ~/sentinel-clean
source ~/.nvm/nvm.sh && nvm use 22.23.4
forge lint
forge deploy
```
Notes:
- `forge login` must be completed interactively before the Forge commands will work.
- No scope changed; `--approve` was not used or required.

## 5. Optional Forge LLM hypothesis path (Task B)
- **Date:** Nov 10, 2026
- **Scope:** Forge LLM (`claude-sonnet-4-6`) behind `src/llm.js`, with the deterministic mock as fallback. No Rovo agent, MCP server, postmortem, external API, deploy, install, or upgrade was run.
- **Dependency:** `@forge/llm` `^1.0.10` is installed (resolved `1.0.10`); `package.json` and `package-lock.json` include it. npm reported 19 vulnerabilities in the existing dependency tree; no `npm audit fix` was run. `@forge/llm` requires the Forge runtime, so plain Node imports fail with `Forge runtime not found`; parser tests import only `src/llmParser.js`.

### Changes
- Added `src/llmParser.js` (pure, no Forge imports):
  - `contentToText` handles a `string` or `ContentPart[]`.
  - `stripCodeFences` removes Markdown code fences.
  - `toPromptFacts` emits only `fact_id`, `fact_type`, `summary`, `observed_at`, and `weight`.
  - `parseHypotheses` validates JSON/shape, drops malformed hypotheses and citations, filters unknown and explicitly blocked fact IDs, deduplicates citations, caps output, and rebuilds citations with the parent `hypothesis_id`.
  - Model-provided `confidence`, `notes`, and other extra fields are not carried.
- Added `src/llm.js` (the only module that imports `@forge/llm`):
  - `MODEL_ID = 'claude-sonnet-4-6'`, `MAX_COMPLETION_TOKENS = 800`, `TEMPERATURE = 0`.
  - `LLM_TIMEOUT_MS = 15000`, well under the 25s resolver limit.
  - The prompt requires JSON only, cites only provided fact IDs, never invents facts, and allows only `supports`/`contradicts`; no confidence is requested.
  - Any timeout, transport error, missing content, malformed JSON, or empty parse falls back to `generateMockHypotheses` with `fallback_used: true` and a reason.
- Updated `src/mockLLM.js` to fixture text: `checkout-service v2.14.0` and `search-service v5.2.1`; removed `Deploy #482`, `Deploy #481`, and `cache TTL`.
- Updated `src/index.js`: `generateHypotheses` now returns `{ status, source, model, fallback_used, fallback_reason, count, hypotheses }`; it passes `remediation_action` IDs from the full ledger as an explicit parser blocklist, and scoring still runs against the full ledger via `calculateConfidence`.
- Updated `src/frontend/index.jsx`: expects the new result object and shows `Source: LLM (claude-sonnet-4-6)` or `Source: Mock (fallback)`, plus a warning `SectionMessage` when fallback is used.
- Updated `manifest.yml` with the `llm` module:
  ```yaml
  llm:
    - key: sentinel-llm
      model:
        - claude
  ```
  No `permissions.scopes` or external egress changed.

### Local checks
- `npm test` (Node 22.23.4): **PASS** — 16 tests, 16 passed, 0 failed.
  - New parser tests cover valid JSON, code-fenced JSON, malformed JSON, fake `fact_id`, remediation `fact_id`, content as `ContentPart[]`, malformed-item dropping, and prompt-field allowlisting.
  - Existing scoring tests still pass; a new assertion checks that mock text matches the fixtures and contains none of the stale strings.
- `npm run lint`: **PASS** (exit 0).
- `npx eslint test/llmParser.test.js test/scoring.test.js`: **PASS** (exit 0).
- Manifest YAML parse and `modules.llm` shape check: **PASS** (key `sentinel-llm`, model `[claude]`, handler still `index.handler`).
- `src/llm.js` stub checks (no network): **PASS**
  - Success: `source: "llm"`, model `claude-sonnet-4-6`, request uses `temperature: 0` and `max_completion_tokens: 800`; prompt contains only the five allowed fact fields; unknown and explicitly blocked remediation citations dropped; model `confidence` dropped.
  - Transport error: falls back to three mock hypotheses with `fallback_used: true`.
  - Malformed JSON: falls back with a visible reason.
  - Empty `choices`: falls back with a visible reason.
  - Timeout: stub hung; fallback returned after **15,016 ms** with `fallback_used: true` and a timeout reason.
- No test or local check called the real Forge LLM or any network endpoint.

### Forge checks
- `forge lint`: **UNVERIFIED** — blocked by CLI authentication.
  - CLI version: `15.0.0` (update `15.1.0` available; not installed).
  - Exact output:
    ```
    Error: Not logged in. If a local keychain is available, run forge login, otherwise set environment variables before trying again. See https://go.atlassian.com/dac/platform/forge/getting-started/#log-in-with-an-atlassian-api-token for more.

    Rerunning the command with --verbose may give more details.
    ```
- `forge eligibility --non-interactive -e development`: **UNVERIFIED** — blocked by the same authentication gate.
  - Exact output:
    ```
    Warning: Your version of Forge CLI is out of date. We recommend you update to the latest version to get the latest features and bug fixes.
    Run npm install -g @forge/cli@latest to update from version 15.0.0 to 15.1.0.

    Error: Not logged in. If a local keychain is available, run forge login, otherwise set environment variables before trying again. See https://go.atlassian.com/dac/platform/forge/getting-started/#log-in-with-an-atlassian-api-token for more.

    Rerunning the command with --verbose may give more details.
    ```
- `forge deploy` and `forge install --upgrade`: **UNVERIFIED** — not run, per instruction. No deployment or upgrade was performed.
- Adding the `llm` module triggers a Forge major-version upgrade even though no scope or external egress changed. No `--approve` rule is expected for this change; `forge install --upgrade` is still required after deploy.

### UI acceptance (not yet verified)
- **UNVERIFIED** — requires deploy + install + browser test:
  - Successful model run shows `Source: LLM (claude-sonnet-4-6)` and the scored rows.
  - Failed model run shows `Source: Mock (fallback)`, the `LLM fallback used` warning, and the scored mock rows.
  - The existing scoring/guard table behavior is unchanged.
  - Real model latency, model availability, rate limits, and billing remain **UNVERIFIED**.

### Commands to finish verification (not run)
```bash
cd ~/sentinel-clean
source ~/.nvm/nvm.sh && nvm use 22.23.4
forge login
forge lint
forge eligibility -e development
forge deploy -e development
forge install --upgrade -e development
```
Notes:
- `forge login` is interactive; complete it in your terminal.
- The `llm` module triggers a major version upgrade; the CLI may prompt for major-version confirmation. No scope/egress approval is expected.
- `forge deploy` and `forge install --upgrade` were deliberately not run.
- If the CLI update is desired, the exact command reported by the CLI is `npm install -g @forge/cli@latest`; it was not run.

## 6. Score saturation fix: context facts, noisy-OR, and ranking (Session 5)
- **Date:** Nov 12, 2026
- **Scope:** Scoring, mock/LLM citation conventions, resolver output, and hypothesis UI only. No MCP server, Rovo agent, postmortem, approval card, manifest scope, or external egress was added. No deploy, install, or upgrade was run.

### Audit: why every live score was 1.00
- `calculateConfidence` kept the maximum weight per cluster and then **summed** those maxima (`sumClusterMaxima`), finally applying `Math.min(1, ...)`.
- The live model cited `fact_alert_001` (weight `0.93`) as `supports` on every hypothesis.
- Each hypothesis also had at least one causal cluster: checkout `0.88`, search `0.28`, so totals reached `0.93 + 0.88 = 1.81` and `0.93 + 0.28 = 1.21`.
- The `1.0` cap then flattened the real checkout hypothesis, the search decoy, and any other hypothesis into the same `1.00` score.
- The root cause was symptom evidence counting as causal support plus an additive formula that saturates; the fix is an explicit context role and noisy-OR combination.

### Changes
- `src/scoring.js`
  - Added `NON_CAUSAL_FACT_TYPES = ['alert']`; matching facts are valid citations with role `context`, contribute zero support/contradiction weight, and are excluded from corroboration and `causal_cluster_count`.
  - Replaced summed cluster maxima with noisy-OR: `support = 1 - product(1 - best_support_weight_per_cluster)` and `contradiction = 1 - product(1 - best_contradict_weight_per_cluster)`.
  - Confidence is `clamp(0, 1, support * (1 - contradiction))`; zero valid citations still returns `0`, and `support < 0.2` still sets `insufficient_evidence`.
  - Kept best weight per cluster, unknown fact ID rejection, remediation blocking, and corroboration as a display-only badge.
  - Added `causal_cluster_count` and `rankHypotheses`: confidence desc, corroboration desc, then supporting causal cluster count desc; assigns 1-based `rank`.
- `src/mockLLM.js`
  - Alert citations are now context; the checkout hypothesis cites the search decoy as `contradicts`, and the search hypothesis cites the checkout deploy as `contradicts`. Irrelevant facts are omitted.
- `src/index.js`
  - Returns structured `citations: [{ fact_id, stance, role }]`, `causal_cluster_count`, and ranked hypotheses with `rank`. Scoring still uses the full ledger so remediation citations are blocked and unknown IDs rejected independently of generation.
- `src/frontend/index.jsx`
  - Added a `Rank` column and per-citation labels: `fact_deploy_root_001 (supports)`, `fact_deploy_decoy_001 (contradicts)`, `fact_alert_001 (context)`.
- `src/llm.js`
  - Prompt now states an alert is the symptom to explain, not causal evidence; alert citations are context with no causal weight; `contradicts` is for weakening facts such as an unrelated deploy; irrelevant facts must be omitted; every hypothesis must cite at least one non-alert fact.
- `src/llmParser.js`
  - Comment clarified that the model supplies stance only and the scorer assigns the causal/context role from `fact_type`. No parser behavior changed.

### Tests
- `test/scoring.test.js` rewritten for the new formula and ranking: **16 tests**.
  - New coverage: alert-only is context with zero support; alert + deploy does not exceed deploy alone; two causal clusters (`0.88` + `0.62`) score `0.9544`, not `1.0`; decoy-only support scores `0.28`; decoy as contradiction lowers `0.88` to `0.6336`; proportional contradiction (`0.4` vs `0.9` gives `0.04`); ranking by confidence, corroboration, then causal clusters; mock citation conventions.
  - Existing tests updated because they assumed the old formula:
    - Contradiction above support previously clamped to `0`; now it is proportional (`0.4 * (1 - 0.9) = 0.04`).
    - Demo root/decoy expectations changed from `0.88`/`0.28` to `0.6336`/`0.0336` because the mock now cites mutual contradictions.
    - Same-cluster test now also asserts `causal_cluster_count` and citation roles.
    - Mock citation test now expects alert context and decoy contradictions.
- `test/llmParser.test.js` unchanged: **8 tests**, all still pass (fake and remediation fact IDs are still dropped).
- `npm test` (Node `22.23.4`): **PASS** — 24 tests, 24 passed, 0 failed.
- `npm run lint`: **PASS** (exit 0).
- `npx eslint test/scoring.test.js test/llmParser.test.js`: **PASS** (exit 0).
- Node emitted the existing benign `MODULE_TYPELESS_PACKAGE_JSON` warning; `"type": "module"` was not added because it could affect Forge packaging.

### Expected scores on the demo fixtures
- Mock checkout hypothesis: confidence `0.6336`, corroboration `2`, causal clusters `1`, rank `1`.
- Mock search hypothesis: confidence `0.0336`, corroboration `1`, causal clusters `1`, rank `2`.
- Mock hallucination: confidence `0` (unknown fact ID rejected, alert is context), `insufficient_evidence: true`, rank `3`.

### Forge checks
- `forge lint`: **UNVERIFIED** — blocked by CLI authentication. CLI version `15.0.0`; update `15.1.0` available but not installed.
  - Exact output:
    ```
    Warning: Your version of Forge CLI is out of date. We recommend you update to the latest version to get the latest features and bug fixes.
    Run npm install -g @forge/cli@latest to update from version 15.0.0 to 15.1.0.

    Error: Not logged in. If a local keychain is available, run forge login, otherwise set environment variables before trying again. See https://go.atlassian.com/dac/platform/forge/getting-started/#log-in-with-an-atlassian-api-token for more.

    Rerunning the command with --verbose may give more details.
    ```
- `forge deploy -e development`: **UNVERIFIED** — not run; requires Forge login. No manifest or scope change, so no `--approve` is expected.
- No scope or egress change was needed.

### UI and live-model acceptance (not yet verified)
- **UNVERIFIED** — requires deploy + install + browser test:
  - Hypothesis table shows the `Rank` column in resolver order (`1`, `2`, `3`).
  - Evidence shows `fact_deploy_root_001 (supports), fact_jira_change_001 (supports), fact_deploy_decoy_001 (contradicts), fact_alert_001 (context)` for the checkout hypothesis.
  - The live model's new prompt behavior, real scores, latency, availability, rate limits, and billing are **UNVERIFIED** until a deployed run is observed.

### Exact commands to finish verification (not run)
```bash
cd ~/sentinel-clean
source ~/.nvm/nvm.sh && nvm use 22.23.4
forge login
forge lint
forge deploy -e development
```
Notes:
- `forge login` is interactive; complete it in your terminal.
- `forge install --upgrade` is not required for this change because the manifest and scopes did not change; the Session 4 install already includes the `llm` module.
- `forge lint` and `forge deploy -e development` were deliberately not run because the CLI is not authenticated on this machine.
