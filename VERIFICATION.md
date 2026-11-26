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

## 7. Remediation proposal and audit log (Session 6)
- **Date:** Nov 13, 2026
- **Scope:** Pure remediation proposal builder, append-only KVS audit records, approval-card UI, and audit-log table. No postmortem, MCP server, Rovo agent, external write, deploy, install, or upgrade was run.
- **Storage:** Proposals and audit records use the existing `storage:app` scope. No manifest scope or egress change was needed.

### Changes
- Added `src/remediation.js` (pure, no Forge imports):
  - `MIN_CONFIDENCE = 0.5`; a hypothesis below that returns `{ proposal: null, reason: "insufficient evidence" }`.
  - `buildProposal(hypothesis, { facts, blastRadius, now })` builds `{ proposal_id, hypothesis_id, action, target, rationale, evidence_fact_ids, blast_radius, instructions, diff, confidence, created_at }`.
  - Action is `rollback` when a supporting causal citation points at a `deploy` fact, otherwise `restart`. Target comes from the deploy fact's `service_scope`.
  - Rollback/restart is explicitly human-executed: `instructions` and a text `diff` are included, and the function performs no external write.
  - `buildTopProposal(hypotheses, options)` picks the rank-1 hypothesis.
  - `proposalKey` / `proposalIdFromKey` provide storage-key helpers.
- Added `src/auditLog.js` (pure, no Forge imports):
  - `AUDIT_KEY_PREFIX = 'sentinel:audit:'`, `AUDIT_INDEX_KEY = 'sentinel:audit:index'`.
  - `buildAuditId(now, suffix)` produces a deterministic ID with a timestamp suffix.
  - `createAuditRecord({ proposal, topHypothesis, decision, note, decidedBy, now, suffix })` builds `{ audit_id, proposal_id, hypothesis_id, decision, decided_at, decided_by, evidence_fact_ids, confidence_at_decision, note }`.
  - `validateAuditRecord` checks the record shape.
  - `auditKey` / `auditIdFromKey` provide storage-key helpers.
- Updated `src/fixtures.js`:
  - Added `BLAST_RADIUS`, a small seeded demo table clearly labelled as seeded demo data, not a live or simulated service graph.
- Updated `src/index.js`:
  - Added `scoreAndRankHypotheses` so `getProposal` and the approval card share the existing scoring path; `generateHypotheses` itself was not changed.
  - Added `getProposal`: reads the ledger, generates and ranks hypotheses, builds the top proposal, and stores `{ proposal, top_hypothesis, created_at }` in KVS so `recordDecision` can audit it without echoing the full proposal from the client.
  - Added `recordDecision({ proposal_id, decision, note })`: reads the stored proposal, writes an append-only audit record with `keyPolicy: 'FAIL_IF_EXISTS'`, and appends the audit ID to the index key. `decided_by` uses `context.accountId` when available, otherwise `"unknown"`.
  - Added `getAuditLog`: reads the audit index and returns the audit records.
- Updated `src/frontend/index.jsx`:
  - Added a "Get Remediation Proposal" button and an approval card showing the top hypothesis, confidence, evidence with stance/role, blast-radius table, human-executed instructions, text diff, optional note, and Approve/Reject buttons.
  - After a decision, the card shows the decision and disables both buttons.
  - Added an Audit Log table, loaded on mount and refreshed after a decision.
  - Loading/resetting the demo or running the hypothesis engine clears any prior proposal and decision.

### Tests
- `test/remediation.test.js`: **6 tests**, all pass.
  - Proposal built for the qualifying top hypothesis (`rollback`, target `checkout-service`, evidence IDs, seeded blast radius, human-executed instructions/diff).
  - Low-confidence and malformed hypotheses return `{ proposal: null, reason: "insufficient evidence" }`.
  - `buildTopProposal` picks rank 1; empty input returns null.
  - Proposal storage key round-trips.
- `test/auditLog.test.js`: **5 tests**, all pass.
  - Audit ID is deterministic with a timestamp suffix.
  - Audit storage key round-trips; index key is correct.
  - Audit record has the required shape and defaults `decided_by` to `"unknown"` and `note` to `null`.
  - Invalid decisions/proposals throw.
- `npm test` (Node `22.23.4`): **PASS** — 35 tests, 35 passed, 0 failed.
- `npm run lint`: **PASS** (exit 0).
- `npx eslint test/remediation.test.js test/auditLog.test.js`: **PASS** (exit 0).
- `node --check src/remediation.js src/auditLog.js src/index.js src/fixtures.js`: **PASS**.

### Expected proposal on the demo fixtures
- Top hypothesis `hypothesis_checkout_v2140` has confidence `0.6336`, so it qualifies.
- Proposal action is `rollback`, target `checkout-service`.
- Blast radius is seeded from `BLAST_RADIUS` and includes `checkout-service` plus its seeded dependents `payments`, `tax-service`, and `frontend`.
- A low-confidence hypothesis (for example the `0.0336` search decoy or the `0` hallucination) returns `{ proposal: null, reason: "insufficient evidence" }`.

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
  - `Get Remediation Proposal` shows the checkout rollback proposal with confidence `0.63`.
  - Evidence shows `fact_deploy_root_001 (supports)`, `fact_jira_change_001 (supports)`, `fact_deploy_decoy_001 (contradicts)`, `fact_alert_001 (context)`.
  - Blast radius shows the seeded checkout service and dependent rows.
  - Approve/Reject writes an audit record, disables both buttons, and refreshes the Audit Log table.
  - A low-confidence run shows `No proposal` / `insufficient evidence`.
  - Real model output, KVS persistence, and the resolver account ID in `decided_by` remain **UNVERIFIED** until a deployed run is observed.

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
- No scope changed, so `--approve` is not expected and `forge install --upgrade` is not required.
- `forge lint` and `forge deploy -e development` were deliberately not run because the CLI is not authenticated on this machine.

## 8. LLM truncation fix, salvage, and one-run proposals (Session 7)
- **Date:** Nov 25, 2026
- **Scope:** Fix the live `Unterminated string in JSON at position 2490` fallback and make the proposal read the same scored run as the hypothesis table. No postmortem, MCP, Rovo, external API, or install was run. The app was deployed to `development` as version `5.4.0`; no manifest, scope, or egress change.

### Task A: truncation diagnosis
- `src/llm.js` set `MAX_COMPLETION_TOKENS = 800`. The observed failure cut the JSON at character 2490 with `Unterminated string in JSON`, which is the signature of an output-token stop mid-string. The 800-token cap was the likely cause.
- The documented `@forge/llm` shape exposes `ChatResponse.choices[0].finish_reason` and an optional `usage` object (`node_modules/@forge/llm/out/interfaces/internal.d.ts`). A truncated response is therefore detectable as `finish_reason: "length"` (the code also treats `max_tokens` and `max_output_tokens` defensively).
- Output budget estimate for 3 hypotheses with up to 5 citations each: roughly 600-800 tokens including JSON field names, IDs, and summaries. 800 was marginal; 2000 gives ample headroom while staying well inside `claude-sonnet-4-6` limits (model is ACTIVE; Anthropic documents 1M context / 128K max output).
- Timeout: `LLM_TIMEOUT_MS` stayed at 15000 ms per attempt. A new total model-phase budget of `LLM_TOTAL_BUDGET_MS = 22000` covers the first attempt plus the one retry, keeping the whole resolver under its 25 s limit.

### Changes
- `src/llm.js`:
  - `MAX_COMPLETION_TOKENS = 2000`.
  - Compact prompt: exactly 3 hypotheses, summaries at most 25 words, at most 4 citations per hypothesis, no extra fields, no confidence.
  - A second, tighter retry prompt: exactly 2 hypotheses, summaries at most 20 words, at most 3 citations.
  - Forge `chat` is injected into `src/llmRun.js`; fallback still returns the deterministic mock but now carries `fallback_reason` (capped at 500 chars) for the UI.
  - Logs `finish_reason`, `output_tokens`, `retry_used`, and `salvage_used` on successful model runs, without secrets.
- Added `src/llmRun.js` (pure, no Forge imports):
  - `finishReasonOf` / `isTruncationFinish` / `usageOf` read the documented response fields.
  - `runChatWithRetry` retries once only on a truncation finish reason; it skips the retry when less than 3000 ms of the total budget remain, and keeps salvaged first-attempt hypotheses if the retry fails.
  - `generateHypothesesWithChat` converts terminal failures into the caller's fallback result.
- `src/llmParser.js`:
  - Parser caps are now 3 hypotheses and 4 citations per hypothesis.
  - Added `parseHypothesesDetailed` and `salvageHypotheses`, plus a balanced-object scanner that respects quoted strings and escapes.
  - Truncated JSON keeps complete hypothesis objects and drops a partial hypothesis; an incomplete citation is never accepted without its closed parent object.
  - Unknown and blocked/remediation `fact_id` filtering is unchanged and still applies to salvaged objects.
- Added `src/runStore.js` (pure):
  - `LAST_RUN_KEY = 'sentinel:last_run'`, version 1.
  - `createStoredRun` stores `{ version, created_at, source, model, fallback_used, fallback_reason, hypotheses, count }`.
  - `isStoredRun` validates a KVS read; `proposalFromStoredRun` builds the proposal from the stored rank-1 hypothesis without calling the model or re-ranking.
- `src/index.js`:
  - `generateHypotheses` writes the ranked run to `LAST_RUN_KEY` and returns `run_created_at`.
  - `getProposal` reads `LAST_RUN_KEY` instead of calling the LLM; without a run it returns `needs_run: true` and `Run the Hypothesis Engine first to score hypotheses.`
  - Load and Reset delete `LAST_RUN_KEY` so a proposal cannot outlive its ledger.
  - Removed the now-unused `scoreAndRankHypotheses` helper and the `buildTopProposal` import.
- `src/frontend/index.jsx`:
  - Proposal card shows the run source (LLM + model, or Mock), the fallback reason when present, and the run timestamp.
  - A missing run shows `Run the Hypothesis Engine first`.

### Local checks
- `npm test` (Node 22.23.4): **PASS** — 49 tests, 49 passed, 0 failed.
  - 35 pre-existing tests plus 14 new: 6 in `test/llmRun.test.js`, 5 in `test/runStore.test.js`, and 3 salvage tests in `test/llmParser.test.js`.
  - New coverage: finish-reason classification; `finish_reason: "length"` triggers exactly one retry with the tighter request; repeated truncation falls back with the exact reason; fully malformed JSON falls back without a retry; truncated JSON keeps complete hypotheses and drops the partial one; a citation whose parent is truncated is not accepted; salvage still drops unknown and remediation IDs; the stored-run shape validates; the proposal builder uses the stored rank-1 hypothesis; a missing run asks for the engine first.
  - No test used the network; `chat` was stubbed in every retry test.
- `npm run lint`: **PASS** (exit 0).
- `npx eslint test/llmRun.test.js test/runStore.test.js test/llmParser.test.js`: **PASS** (exit 0).
- `node --check` on `src/llm.js`, `src/llmRun.js`, `src/llmParser.js`, `src/runStore.js`, `src/index.js`: **PASS**.
- Confirmed no stale `scoreAndRankHypotheses` or `buildTopProposal` references remain in `src/index.js`.

### Forge checks
- `forge lint`: **PASS** — `No issues found.` (Forge CLI `15.0.0`, Node `22.23.4`, Nov 25, 2026).
- `forge deploy -e development`: **PASS** — `sentinel-clean` version `5.4.0` deployed to `development`. The deploy ran `forge lint` again and reported no issues.
- `forge login`: did not persist credentials because `libsecret` is unavailable in WSL (`The CLI couldn't securely store your login credentials in a local keychain...`). Authentication was still available for the lint and deploy commands in that shell. Do not put the API token in the repo; use `libsecret` or the documented `FORGE_EMAIL` / `FORGE_API_TOKEN` environment variables in a future shell if needed.
- No manifest, scope, or egress change was made, so no `--approve` was required and `forge install --upgrade` is not required.

### UI and live-model acceptance
- **PASS** — live run on deployed version `5.4.0`, Nov 25, 2026:
  - `Run Hypothesis Engine` returned `Source: LLM (claude-sonnet-4-6)` with no truncation and no fallback. Three hypotheses were scored.
  - Rank 1 was `hyp_001`, summary `Synchronous tax calculation added in v2.14.0 introduced latency on the checkout request path.`, confidence `0.95`, corroboration `3`, with `fact_deploy_root_001`, `fact_jira_change_001`, and `fact_runbook_step_001` as causal supports and `fact_alert_001` as context.
  - `Get Remediation Proposal` showed `Action: rollback`, `Target: checkout-service`, `Confidence: 0.95`, `Run source: LLM (claude-sonnet-4-6)`, and `Run scored at: 2026-11-25T14:00:31.374Z`.
  - The proposal's hypothesis ID, summary, confidence, and evidence match rank 1 exactly. The old mismatched second-call proposal no longer occurs.
  - Approving wrote audit record `audit_2026-11-25T14-00-49-010Z_mww6yhde_ogq88z_0` with proposal `proposal_hyp_001_2026-11-25T14-00-40-838Z`, hypothesis `hyp_001`, confidence `0.95`, and the same four evidence fact IDs. The Audit Log table refreshed and showed the record.
  - The no-run state shows `No hypotheses scored yet...` and `Get Remediation Proposal` returns `Run the Hypothesis Engine first to score hypotheses.`
  - The two earlier audit rows from the old deployment remain; append-only retention is expected.
- **UNVERIFIED**:
  - A live `finish_reason: "length"` retry and live truncated-JSON salvage were not exercised; both are covered only by stubbed `node:test` tests.
  - Exact model latency was not measured. This run completed successfully, but the 22 s total budget and 3 s minimum retry budget were not stressed live.
  - The reset-clears-the-stored-run path is consistent with the observed no-run message, but the reset action was not timed independently.
  - The proposal evidence table shows `fact_alert_001` with stance `supports` and role `context`; scoring still gives it no causal weight. The stance label is model-provided, not a scoring change.

### Commands run for deployment
```bash
cd ~/sentinel-clean
source ~/.nvm/nvm.sh && nvm use 22.23.4
forge login
forge lint
forge deploy -e development
```
- `forge login` reported the keychain error above; `forge lint` and `forge deploy` still completed.
- Browser flow completed on deployed version `5.4.0`: Load demo scenario, Run Hypothesis Engine (LLM, no fallback), Get Remediation Proposal (matching rank 1), Approve (audit record written).
- If the retry or salvage path is exercised later, capture the logged `finish_reason`, `output_tokens`, `retry_used`, and `salvage_used` values before changing code.

## 9. Postmortem generator and synthetic benchmark (Session 8)
- **Date:** Nov 26, 2026
- **Scope:** Pure postmortem builder, latest-proposal pointer, four synthetic benchmark scenarios, pure benchmark runner, and UI sections. No MCP server, Rovo agent, Confluence write, manifest scope, or external egress was added. No deploy, install, or upgrade was run. The Session 8 code is local only and has not been deployed.

### Changes
- Added `src/postmortem.js` (pure, no Forge imports, no writes):
  - `buildPostmortem({ facts, run, proposal, audits, generated_at })` returns one structured object with `available`, `summary`, `timeline`, `root_cause`, `rejected_hypotheses`, `decision_lineage`, `action_items`, and `markdown`.
  - Markdown has exactly these sections: Summary, Timeline, Root Cause, Rejected Hypotheses, Decision Lineage, Action Items.
  - Timeline includes every stored fact, sorted by `observed_at` ascending with `fact_id` as the tie-breaker. `remediation_action` rows are labelled `response action — never a cause`.
  - Root-cause evidence filters remediation citations even from a malformed stored run and reports omitted IDs separately.
  - Rejected reasons are derived from stored data: contradictions (`contradicted by <fact_id>`), nonexistent citations (`citations rejected as nonexistent: <fact_id>`), blocked remediation citations, insufficient evidence, or being outranked by the top hypothesis.
  - Decision lineage matches the latest proposal ID, plus same-top-hypothesis audits at or after `run.created_at` so a regenerated proposal ID does not erase lineage.
  - Action items come only from the stored proposal, are labelled human-executed suggestions, and add `Review change <ticket>` when proposal evidence includes a Jira change.
  - A missing run returns `available: false` plus `Run the Hypothesis Engine first to generate a postmortem. No stored run exists.`
- Added `src/benchmark.js` (pure, no Forge or KVS imports):
  - `runBenchmark({ scenarios, generate })` accepts an injected async generator and runs scenarios sequentially.
  - Evaluation uses the product's real `calculateConfidence` and `rankHypotheses`; top-1/top-3 require a valid causal `supports` citation to a ground-truth fact. Abstention is the top confidence being below `0.5`.
  - Metrics: `top1_accuracy`, `top3_accuracy`, `abstention_correctness`, `hallucinated_citations_blocked`, `remediation_citations_blocked`, plus counts and pass/error totals.
  - Generator errors are per-scenario failures, not valid abstentions. Malformed scenarios throw before any generator call.
  - `summarizeBenchmarkResults(results)` lets the UI merge results from multiple resolver invocations and recompute the same metrics.
  - `BENCHMARK_LABEL = 'synthetic scenarios authored by the developer'`.
- Updated `src/fixtures.js`:
  - Added `buildBenchmarkScenarios(now)` with four synthetic scenarios:
    - `bench_clear`: ground truth `bench_clear_deploy`.
    - `bench_decoy`: a recent unrelated search deploy is the decoy; ground truth is the older `bench_decoy_true_deploy`.
    - `bench_remediation`: the most recent, highest-weight `bench_remediation_action` is a response action; ground truth is `bench_remediation_true_deploy`.
    - `bench_weak`: `{ abstain: true }`; even citing every weak fact gives `0.45634`, below `0.5`.
- Updated `src/runStore.js`:
  - Added `LAST_PROPOSAL_KEY = 'sentinel:last_proposal'`, `createProposalPointer`, and `isProposalPointer`. The pointer stores only `{ version, proposal_id, created_at }`; the proposal body stays under its own key.
- Updated `src/index.js`:
  - `getPostmortem` reads the stored run, ledger, latest proposal pointer/body, and the shared audit reader. No run returns a clear `available: false` result.
  - New runs, Load, and Reset clear the proposal pointer. `getProposal` sets it only when a qualifying proposal exists.
  - Added live `runBenchmark`: it runs exactly one pending synthetic scenario per resolver invocation using the existing 15 s attempt / 22 s model budget, then returns `remaining_scenario_ids` for the UI loop. It never reads or writes the real ledger, stored run, proposals, or audit log, and throws away any LLM fallback-to-mock result.
- Updated `src/frontend/index.jsx`:
  - Added a Postmortem section with a `Generate Postmortem` button, Markdown in a `CodeBlock`, a no-run warning, and the note that Confluence publishing is not implemented.
  - Added a Benchmark section with a `Run Benchmark` button, expected-vs-predicted/pass-fail table, summary metrics, the synthetic-scenario label, and a loop that calls the resolver until every scenario has a result.
  - Running the engine, getting a proposal, loading, resetting, or recording a decision clears the stale postmortem. Benchmark results stay visible because they are synthetic and independent of the real ledger.
- Added `test/postmortem.test.js` and `test/benchmark.test.js`; added a proposal-pointer test to `test/runStore.test.js`.

### Local checks
- `npm test` (Node `22.23.4`): **PASS** — 71 tests, 71 passed, 0 failed.
  - 49 pre-existing tests plus 22 new: 10 postmortem tests, 11 benchmark tests, and 1 proposal-pointer test.
  - Postmortem coverage: all six sections; timeline includes every fact in order and includes remediation; remediation never appears in root-cause evidence, including a malformed stored run; omitted citations are noted; rejected reasons cover contradiction, nonexistent citation, blocked remediation, insufficient evidence, and outranked; decision lineage matches the proposal and survives regeneration; no-proposal fallback; action items and Jira review suggestion; no-run message.
  - Benchmark coverage: fixture IDs and ground truth; all four pass with a stub (`top1_accuracy 1`, `top3_accuracy 1`, `abstention_correctness 1`, remediation citations blocked `2`, hallucinated citations blocked `0`); hallucinated citations counted as blocked; hallucination-only answer fails; decoy prediction fails; abstention failure when a hypothesis clears `0.5`; top-3 pass while top-1 fails; generator error is a failure; metrics recompute identically across invocations; benchmark source has no KVS/stored-run/proposal/audit dependency; malformed scenarios fail before the generator.
  - No test used the network or the real Forge LLM; every benchmark generator was a local stub.
- Demo postmortem smoke check (stubbed, pure modules): **PASS**
  - Timeline order: `fact_jira_change_001`, `fact_deploy_root_001`, `fact_deploy_decoy_001`, `fact_alert_001`, `fact_runbook_step_001`, `fact_remediation_001`.
  - Root evidence excludes `fact_remediation_001`; the Markdown section check passes for all six sections.
  - Mock top hypothesis `hypothesis_checkout_v2140` at `0.6336`; rejected reasons include `contradicted by fact_deploy_root_001` and `insufficient evidence (confidence 0.00)`.
  - Action items: `Roll back checkout-service (human-executed; Sentinel does not perform it).` and `Review change OPS-1421 with the change owner before executing.`
- `npm run lint`: **PASS**.
- `npx eslint test/postmortem.test.js test/benchmark.test.js test/runStore.test.js`: **PASS**.
- `node --check src/index.js` and `node --check` on the new pure modules: **PASS**.
- `git diff --check`: **PASS** (no whitespace errors).
- No manifest, scope, or dependency change was needed.

### Forge checks
- `forge lint`: **UNVERIFIED** for the Session 8 code — blocked by CLI authentication in the current shell. The Session 7 `forge lint` PASS was for the previously deployed code, not this working tree.
  - Exact output:
    ```
    Warning: Your version of Forge CLI is out of date. We recommend you update to the latest version to get the latest features and bug fixes.
    Run npm install -g @forge/cli@latest to update from version 15.0.0 to 16.0.0.

    Error: Not logged in. If a local keychain is available, run forge login, otherwise set environment variables before trying again. See https://go.atlassian.com/dac/platform/forge/getting-started/#log-in-with-an-atlassian-api-token for more.
    ```
- `forge deploy --non-interactive -e development`: **UNVERIFIED** — deliberately not run. No deployment was performed.
- `forge install --upgrade`: not required; no manifest or scope changed.

### UI and live-model acceptance (not yet verified)
- **UNVERIFIED** — requires deploy + install + browser test:
  - `Generate Postmortem` renders the Markdown document with all six sections, and the Confluence-not-implemented note is visible.
  - With no stored run, the button shows the no-run warning instead of an invented postmortem.
  - `Run Benchmark` completes the UI loop, shows four rows with expected vs predicted and Pass/Fail, and shows the summary metrics.
  - The live benchmark really runs the LLM once per scenario, stays under the 25 s resolver limit, and does not write to the real ledger, stored run, proposals, or audit log.
  - Live model accuracy, abstention behavior, latency, and billing remain **UNVERIFIED**; the benchmark tests use stubs only.
  - Exact benchmark prediction quality for the four scenarios is **UNVERIFIED** until a deployed run is observed.

### Commands run for local verification
```bash
cd ~/sentinel-clean
source ~/.nvm/nvm.sh && nvm use 22.23.4
npm test
npm run lint
npx eslint test/postmortem.test.js test/benchmark.test.js test/runStore.test.js
node --check src/index.js
git diff --check
```

### Exact commands to finish verification (not run)
```bash
cd ~/sentinel-clean
source ~/.nvm/nvm.sh && nvm use 22.23.4
forge login
forge lint
forge deploy --non-interactive -e development
```
Notes:
- `forge login` is interactive; complete it in your terminal.
- No manifest, scope, or egress changed, so no `--approve` or `forge install --upgrade` is expected.
- After deploy, run the UI acceptance checklist above and record the live benchmark metrics.
