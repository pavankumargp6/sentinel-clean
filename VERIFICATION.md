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
