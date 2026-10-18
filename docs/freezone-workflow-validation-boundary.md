# Freezone Workflow Validation and Confirmation Boundary

A workflow plan, the `compiled.ok` returned by an Agent, and a tool success message are neither execution authorization nor proof of completion.

- When creating or modifying a draft and when claiming a confirmation task, the API re-validates the plan using the authenticated user's Skill/Recipe catalog.
  It does not use the username in the process environment, and does not trust derived fields submitted by the caller such as preflight results or node counts.
- Plans and canvas commands share the text-edge role check. Ordinary text without a role can have its purpose inferred from the edge; an explicitly declared
  `semanticOutputRole` and the compatibility field `ioRole` must not be rewritten in order to pass validation.
- A confirmation can only execute the saved version's `run_after_create`. Changing the execution policy requires modifying the draft first, bumping the version,
  and then confirming the new version; it cannot be overridden in the confirmation tool call.
- The node commands of the confirmation tool carry the draft version and the persistent task ID. The API reads these bindings from the pending command and must not
  accept substitutes from the receipt request body. A late receipt must not end a different version or a different task.
- The ordinary completion endpoint only accepts submitted/failed status updates bound to the task and version, and does not accept `confirmed`.
  Successful delivery is handled by browser session receipts; an Agent session must not submit canvas execution receipts.
- HTTP, running WebSocket, and idle WebSocket use the same receipt handling entry point. Workflow confirmation
  must go through that entry point, and even if MCP direct canvas write is configured, it must not take the direct-apply path that lacks receipts.
- A canvas confirmation only proves delivery of the canvas operation and does not mean media generation is complete. Subsequent generation continues to go through the existing project permissions,
  model capability checks, task envelope verification, and billing flow.

At deployment the backend and the Freezone plugin must be updated together. An old plugin's in-flight receipt that does not carry the task/version binding will be
rejected for confirmation; drain the workflows being confirmed before updating, and start a new Agent session after the update. Do not restore old tasks by manually
marking `confirmed` or turning validation off.

Regression coverage is in `test_workflow_semantics.py`, `test_api_freezone_workflow_runs.py`,
`test_freezone_workflow_drafts.py`, `test_freezone_plugin.py`, and `test_chat_route_prewarm.py`.

## Third-party fixed-flow tools (workflow-operations.v1)

The business implementation lives in the backend `workflow_transactions.py`, and MCP only forwards requests with identity.
New tools `freezone_prepare_workflow`, `freezone_revise_workflow`, `freezone_get_workflow`, and
`freezone_get_workflow_capabilities` were added. Both preparing and modifying need only one HTTP request and return a summary,
so the Agent does not need to download, rewrite, and send back the whole compile result. The old tools remain compatible.

- POST workflow-drafts accepts an intent or a full plan, optionally with business-purpose bindings; the backend compiles and validates.
- PATCH workflow-drafts accepts expected_revision + changes; the backend reads, modifies, validates, and saves with CAS.
- GET workflow-drafts/{id}?view=summary returns the draft and confirmation state, avoiding sending back the whole graph.
- GET workflow-capabilities returns the protocol version and execution adapter capabilities.

The catalog snapshot is bound to the API-authenticated user, with concurrent requests isolated by ContextVar, and the process environment is not modified.
Edge bindings do not change existing text roles; when planning content is used for generation, an independent actual prompt must be provided.
Illegal modifications are not persisted; version conflicts and timeouts must not be blindly retried or automatically adopt the new version.

Agent Kit 0.2.0 requires workflow-operations.v1 and publishes the Skill in sync.
It still uses canvas_approval_bridge with headless_execution=false: third-party prepare, modify, and query are supported,
which does not mean a standalone background media executor is provided. The constraints on permissions, billing admission, confirmation tasks, and browser receipts remain in effect.


## Run preflight and tracking additions (Agent Kit 0.3.0)

Model capability validation is centralized in workflow_preflight.py; the old plugin and the API reuse the same implementation. Before create, modify, and
claim, the API reads the authenticated user's live catalog and does not trust the caller's preflight-passed flag. It validates aspect ratio, resolution, quality,
duration range, audio support, and parameter types. When the model catalog is unavailable, explicit model requests are blocked; when queue information is unavailable, a warning is given,
and the final enqueue still uses the existing permission and quota checks.

Run detail queries now share task and artifact reconciliation with the list. freezone_observe_workflow_run provides a bounded wait of up to 20 seconds,
a status token, a progress summary, and recovery suggestions; no background polling task is kept after the request ends.
A read timeout can be retried; in uncertain outcomes such as generation timeouts and connection interruptions, reconciliation is required first. The observe tool does not replay paid
generation, does not take over run leases, and does not change confirmation permissions. Continuous background scheduling is still not a capability of the current canvas adapter.
