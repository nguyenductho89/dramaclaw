# Issue #480 / PR #434 Cross-Repository Acceptance Matrix

The baseline is the "final implementation plan" published by PR #434 at 2026-09-04 00:35. Its §10
actually lists 18 items; this table does not substitute the total test count for item-by-item acceptance, nor count generic billing tests as
real paired-head verification of the four Agent products.

Meaning of the statuses:

- **Auto-covered**: the current codebase has direct regression tests.
- **Partially covered**: single-repository or generic lifecycle is tested, but real paired/live evidence is still missing.
- **Not covered**: needs follow-up code or an acceptance environment.

| # | Acceptance item | Status | Current evidence | Follow-up action |
|---|---|---|---|---|
| 1 | Unconfigured, disabled, free/0, and positive prices for the four features | Partially covered | SuperTale generic strict-price tests; PR #186 registration tests | Run the four-price matrix for each of the four features with the latest CE/EE heads |
| 2 | Unconfigured / insufficient balance fails before the model call and delivers no result | Partially covered | SuperTale strict-price and insufficient-balance tests; CE operation admits first, then returns results | The paired test asserts the model call count is 0 and there is no result receipt |
| 3 | started/queued/running are not finally consumed | Partially covered | `tests/test_agent_product_operations.py` pending state; SuperTale generic task settlement | The paired test checks that the reservation is not confirmed |
| 4 | Refund when no model call occurred | Partially covered | CE forbids delivered without evidence; SuperTale generic failure refund | The paired test checks the refund ledger of the four kinds of tasks |
| 5 | Confirm only once after the model succeeds and the result is delivered | Auto-covered | `tests/test_agent_product_operations.py` terminal-state idempotency; `tests/test_api_freezone_workflow_runs.py` duplicate Workflow result submission | The paired ledger can serve as extra release evidence |
| 6 | Refund/review for provider rejection, no result, cancellation, and process interruption | Partially covered | `tests/test_task_timeout.py`, `tests/test_agent_product_operations.py` | Add process-interruption paired tests for the four kinds of operations |
| 7 | accepted/submitted keep the reservation; restart and late results converge | Partially covered | late delivery confirmation and `awaiting_reconciliation` tests; diagnostic counters | Execute one timeout → restart → confirm/refund in a real EE |
| 8 | Duplicate MCP, transport retry, and duplicate finish/save do not charge twice | Auto-covered | operation idempotency, terminal result_ref consistency, Workflow draft duplicate submission tests | The paired ledger can serve as extra release evidence |
| 9 | Skill-only, Recipe-only, Skill + N Recipes, reuse-only Recipes | Auto-covered | `tests/test_freezone_plugin.py` Skill Studio modes; server-side manifest/reuse validation | None |
| 10 | N new Recipes correspond to N `recipe_generate` operations | Auto-covered | `tests/test_freezone_plugin.py::test_freezone_plugin_recipe_only_manifest_admits_and_delivers_each_recipe`; server-side count validation | None |
| 11 | N model-based Recipe nodes correspond to N `recipe_result`; deterministic paths are free | Auto-covered | `tests/test_api_freezone_workflow_runs.py` workflow-run admission and deterministic compile tests | None |
| 12 | Workflow result is charged once; Canvas confirm/apply does not charge again | Auto-covered | `test_metered_workflow_result_is_delivered_once_before_canvas_confirmation` | The paired ledger can serve as extra release evidence |
| 13 | CRUD, import, copy, save, schema validation, and deterministic compile are not charged | Partially covered | CE routes have no product operation; deterministic compile regression | Add a cross-repository "zero ledger events" summary test |
| 14 | Large amounts of text are charged extra by trusted `billable_chars` | Partially covered | the text runner persists actual output characters and creates an idempotent reservation by the result, the task core only confirms that reservation; EE enqueue does only price/balance preflight; Workflow MCP/planning replies reject body text bypasses over 4000 characters | Run a paired ledger with real personal/organization prices to confirm the actual character amount and the single terminal state |
| 15 | Image/audio/video costs are not suppressed by the parent operation's `feature_included` | Partially covered | SuperTale generic tests of `feature_included` and independent media features | The paired workflow asserts both the parent product ledger and the media ledger |
| 16 | Partial success confirms/refunds independently per artifact | Partially covered | each Recipe has an independent operation; a failure terminates only the corresponding operation | Add a mixed success/failure paired ledger test |
| 17 | Personal, organization, member quota, organization override price | Partially covered | SuperTale generic organization billing tests | Run the organization override price paired test for the four new features |
| 18 | CE works end to end with no local credit ledger | Auto-covered | CE uses `NoOpUsageMeter`; `agent_billing_state.py` does not exist; CE Workflow/Skill Studio tests | None |

## Evidence added on this branch

- `53e3a30e`: the server cross-validates the manifest, outline, put result, operation session/kind/artifact
  and the truly reusable Recipes; it also validates the Workflow result operation against `compiled.skill_id`.
- `d2e7e3be`: diagnostic counters cover evidence binding failures, 409 for missing evidence, entering reconciliation, and late-result completion.
- Current A1 change: the text task creates and confirms a trusted `billable_chars` idempotent reservation from the actually delivered content;
  EE enqueue does only price/balance preflight; Workflow Plan/MCP and planning replies both reject body text bypasses over 4000
  billable characters.
- 2026-09-05 paired gate: CE `2b368b2d` + a follow-up commit `8188a7d` of the PR #186 head;
  product evidence suite 150 passed, EE contract suite 127 passed.
- Full CE regression: 5183 passed, 16 skipped, 3 deselected; 3 of them failed at first because of port/network restrictions in the restricted sandbox,
  and passed when re-run separately after the corresponding capability was allowed.

## Evidence that still needs to be saved manually before release

1. Run the paired gate with the exact heads of the current DramaClaw and SuperTale PR #186.
2. Under real price configuration, execute one each of Workflow result, Recipe result, Workflow generate, and
   Recipe generate, and save the correlated records of reservation, model evidence, result receipt, and terminal settlement.
3. Deliberately cause one accepted/submitted timeout and restart, and confirm that the reservation finally converges and the diagnostic counters change correctly.
4. After A1 is complete, run one success and one failure with a large block of text, and check the actual output character billing and that a failure does not confirm.
