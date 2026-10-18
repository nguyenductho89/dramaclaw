# Freezone Server-Side Orchestration Migration Decision

Status: Proposed  
Target branch: staging  
Related: #557, #558, #559

## Decision summary

The end goal of the Freezone Workflow is for a server-side Orchestrator to hold exclusive authority over state advancement. The browser is responsible for editing
Drafts, submitting approvals, executing UI commands that must rely on browser capabilities, and projecting server events onto the Canvas;
the browser must not confirm on its own that a persisted Action is complete.

The migration follows the order "establish contracts and a persistence channel first, then transfer scheduling authority, and finally delete the old state machine". During the migration,
each Run is allowed only one execution owner, and it is forbidden for the same Run to be advanced by both the browser runner and the server
orchestrator at the same time.

## Invariants

1. An Agent can only propose a versioned Workflow Draft and cannot directly create an approved Run.
2. User approval produces an immutable approval record; Commit and mainline sync always stop at a manual gate.
3. Run, Action, Task, Artifact, and Product Operation use the same set of correlation IDs.
4. Before an Action enters completed it must satisfy the server-side evidence policy for its `action_type`; Task/Artifact must not be
   treated as a universal precondition for all actions.
5. Terminal states advance one way only; a late receipt cannot overwrite applied, failed, cancelled, expired, or completed.
6. Delivery retries of the same Command reuse the command-level idempotency key and increment attempt; dead-letter replay uses a new
   command-level idempotency key but reuses the operation-level idempotency key, ensuring the Canvas mutation is not applied twice and billing is not charged twice.
7. The Canvas is a rebuildable projection of the Run, not the source of execution facts.

## Target boundaries and dependency direction

```text
Web / Agent
    │  draft, approve, cancel, subscribe
    ▼
Workflow Application
    ├── Tool Policy / Approval Policy
    ├── Workflow Schema
    └── Orchestrator
          │
          ├── Workflow Repository
          ├── Command Inbox / Outbox
          ├── Task Port
          ├── Artifact Verifier
          └── Product Operation Port
                    │
                    ▼
Runtime Adapters (Codex / Hermes) and Task Runners
```

Dependencies may only point downward. The business layer depends on `AgentRuntimePort` and the ports above, and does not read raw Codex or Hermes
events. The Runtime Adapter maps raw events into unified events:
`turn.started`, `tool.requested`, `tool.result`, `turn.completed`,
`turn.failed`, `turn.interrupted`.

## Authoritative data model

### Workflow Run

- `run_id`, `workflow_schema_version`, `draft_hash`
- `principal_id`, `project_id`, `canvas_id`, `agent_id`, `turn_id`
- `approval_id`, `status`, `owner_kind`, `owner_id`
- `lease_expires_at`, `created_at`, `updated_at`

### Workflow Action

- `action_id`, `run_id`, `depends_on`, `action_type`
- `operation_idempotency_key`, `payload_hash`, `attempt`, `status`
- `task_id`, `artifact_ids`, `product_operation_id`
- `requires_user_approval`, `approval_id`
- `evidence_policy`, `result_receipt_id`, `projection_revision`

The completion evidence of an Action is defined by type:

| Action type | Required evidence before completed |
|---|---|
| Generation action | Task success terminal state + server-verified Artifact; paid actions also need an associated Product Operation |
| Canvas mutation / UI command | Server-verified Command `applied` receipt + corresponding Canvas projection revision; pure UI actions record the revision observed at execution |
| Manual mainline action | Approval record from an authorized principal + mainline business result receipt and its revision |

`evidence_policy` is decided by the versioned Workflow Schema according to `action_type`, and Drafts and clients
cannot override it. When the corresponding evidence is missing, the Action stays running/awaiting_evidence, and an empty Task or
Artifact must not be forged to enter completed.

### Command Inbox / Outbox

- `command_id`, `command_idempotency_key`, `operation_idempotency_key`
- `replay_of`, `payload_hash`
- correlation fields for principal/project/canvas/agent/turn/run/action
- Normal path: `pending → delivered → accepted → applied`
- `applied` is an irreversible success terminal state; failure terminal states are `failed | cancelled | expired`
- `consumer_id`, `lease_expires_at`, `attempt`, `available_at`
- `result_payload`, `result_expires_at`

The command-level and operation-level idempotency keys carry different responsibilities:

- `command_idempotency_key` identifies one command creation intent. The same key with a different
  `payload_hash` must return a conflict; the same hash returns the existing command.
- `operation_idempotency_key` identifies a business side effect that must not repeat, and stays unchanged between the original command and all its replays.
  Canvas mutations, Product Operations, and billing settlement must de-duplicate on this key.

All compare-and-set state updates and idempotency key reservations must be completed inside a persistence transaction.

Delivery and timeout rules:

1. When a consumer takes a command, it uses CAS to change pending to delivered and writes the consumer and
   lease at the same time; after takeover is confirmed it changes to accepted, and renews the lease during execution.
2. When the lease of delivered or accepted expires and the maximum attempt count has not been reached, the server clears the old consumer,
   increments attempt, and puts it back to pending with the same command_id/command_idempotency_key; redelivery
   must not create a new business action or billing Operation.
3. On reaching the maximum attempt count, exceeding the command TTL, or an unrecoverable payload, it becomes expired, and a
   dead-letter record and the last failure reason are written for manual replay or audit.
4. applied, failed, cancelled, and expired are all irreversible terminal states. Result handling is only allowed to CAS from the currently valid
   delivered/accepted lease; a late ack/result from an old consumer must return the terminal snapshot and
   must not overwrite a terminal state or a newer attempt.
5. Replaying a dead letter must, within one transaction, create a new command_id and a new
   command_idempotency_key, and point to the original command through replay_of; reusing the original command-level idempotency key is forbidden.
   The new command must inherit the original operation_idempotency_key. If that business key already has an applied/settled
   result before execution, the replay reuses that result and enters applied directly, and must not modify the Canvas again or create a billing Operation.

## Deployment support matrix

| Mode | Command transport | Run owner | Support level |
|---|---|---|---|
| CE single process | Database Inbox/Outbox; file-bridge compatibility adapter | Server | Official |
| CE multiple API workers, shared project database | Database Inbox/Outbox | Server | Official |
| Multi-node, no shared local filesystem | Redis Stream or centralized database | Server | Official |
| Legacy file bridge | pending/result files | Browser | Migration period only, multi-node not supported |

The file-bridge adapter only implements the new CommandPort and no longer exposes file names, polling, and lock semantics to the business layer. The adapter
must have result TTL, startup cleanup, conflict detection, and metrics; a distributed configuration that detects the file bridge should refuse to start.

## Phased migration

### Phase 0: safety gates

- Mainline Commit and BeatContext sync are allowed only through the manual UI.
- Introduce a server-trusted AgentExecutionContext; client metadata does not take part in tool authorization.
- Owner: the existing browser runner; the server only validates and records.
- Exit criteria: the safeguards and regression tests of #555 and #556 are merged.

### Phase 1: unified contract and correlation IDs

- Publish `workflow-schema/v1`, defining the Draft, Run, Action, Command, and Result envelope.
- `workflow_runs.py` completes the task/artifact/product-operation correlation and CAS state rules.
- Establish a single schema source for the Node, Link, Action, and Recipe stable envelopes.
- Generate the Python models, TypeScript types, and MCP input schema from the schema.
- Owner: still the browser runner; only the browser can advance legacy Runs.
- Exit criteria: the CI contract test can detect drift in enums, fields, aliases, and the schema version.

### Phase 2: persistent Inbox/Outbox

- Implement the CommandPort and the database transport; WebSocket becomes subscribe/ack.
- The file bridge is downgraded to a CE single-machine adapter, with TTL, cleanup, and metrics added.
- New Commands use the persistent transport; old Runs keep the original transport until their terminal state.
- Owner: legacy Runs are browser-owned; the delivery owner of new commands is the server.
- Exit criteria: tests for cross-API-worker, reconnect after disconnect, idempotency conflict, and late receipts pass.

Current implementation baseline: Canvas Command, Canvas Context, Skill Studio, and Clarification are already written to the SQLite Inbox/Outbox in the bridge
directory; API workers compete for delivery leases through transactional CAS, and after a browser disconnects, messages can be redelivered from the
same Inbox. The old pending/result JSON is still kept as a dual-write adapter during the migration, but is no longer the only source of truth for new requests.
Terminal results are retained for 24 hours, and unfinished messages become expired by per-type TTL; queue state can be read through
`bridge_status_counts`.

This SQLite transport requires all API workers to mount the same bridge directory. It officially covers CE single process and
CE multi-worker setups that share this directory; deployments across hosts without shared storage must switch to a
centralized database or Redis Stream implementing the same CommandPort, and until that transport lands, node-local SQLite must not be declared as
multi-node support. The file dual-write only serves legacy-version compatibility and rollback, and does not change this deployment boundary.

### Phase 3: server Orchestrator shadow mode

- The Orchestrator reads the Run and computes the next action, but does not schedule; it only records differences against the browser's decisions.
- Establish golden tests for DAG expansion, retry classification, and Artifact verification.
- Owner: browser; shadow must not write Action state.
- Exit criteria: no unexplained decision differences during a continuous observation window.

### Phase 4: switch the execution owner per Run

- When a Run is approved, persist `owner_kind=server` or `browser_legacy`, immutable after creation.
- A server-owned Run has the Orchestrator acquire a lease, schedule Tasks, verify Artifacts, and advance the DAG.
- The browser only applies Canvas projection events carrying a revision.
- Owner: decided solely by the Run field.
- Exit criteria: it keeps running after the browser is closed; tests for cancel, resume, worker switching, and multiple tabs pass.

### Phase 5: remove the browser runner

- Forbid creating browser-owned Runs, and delete the scheduling and reconciliation logic after old Runs reach terminal states.
- Keep the UI command consumer, handling only actions that truly need browser capabilities, such as upload pickers.
- Split the large modules and delete the dual-write compatibility branches.

## Module split order

Avoid mechanical splitting by file; extract by stable responsibility:

1. `chat/execution_context.py` and `chat/tool_policy.py`
2. `chat/application.py`: use-case orchestration of one turn
3. `chat/runtime_port.py` and `chat/adapters/{codex,hermes}.py`
4. `chat/session_registry.py`, `chat/delivery_evidence.py`
5. `freezone/orchestrator.py`, `freezone/command_port.py`
6. Split routes into thin adapter layers for canvas, catalog, workflow, operation, asset

Every extraction must first have a characterization test, and the old entry point delegates to the new module; rewriting behavior at the same time is not allowed.

## Single source of truth for the schema

The stable envelope goes into the independent, versioned directory `schemas/workflow/v1`. Generated artifacts must carry the source schema
hash, and CI performs a check that "git diff is empty after regeneration". The model catalog, prices, and live capabilities do not enter the
stable schema and continue to be provided by the live catalog; the schema only defines the envelope of catalog items.

Compatibility rules:

- Adding optional fields is allowed to evolve within the same version; deletion, renaming, and semantic changes must bump the major version.
- Aliases exist only in the inbound migration layer and are normalized before persistence.
- An unknown major fails closed; unknown optional fields are passed through but cannot take part in authorization.

Current migration baseline: `schemas/workflow/v1/stable-contract.json` has become the release source of the Workflow node/link, generation
action, compatible model alias, and Recipe envelope; the Python, TypeScript, and MCP JSON
snippets are generated by `scripts/generate_workflow_contract.py`, and the `--check` mode of CI blocks drift of the generated artifacts.
Dynamic model availability and parameters still come only from the live catalog and are not written into this stable contract.

The provider-neutral event/stream Protocol of Chat lives in `chat/runtime_port.py`, and the tool policy of Surface and Agent
Profile lives in `chat/tool_policy.py`. The old `backend_sdk` and `chat.service` temporarily keep
compatible exports, and later adapter/route splits may only let the old entry points delegate to the new modules, and must not copy constants or policies again.

The tool-name policy sets (mainline write tools, Freezone canvas write / terminal write, workflow draft, Agent product results,
display tools, hidden-tool markers) are declared only in `chat/tool_policy.py`; `hermes_sdk`,
`runtime_event_evidence`, `chat.service`, `display_fallback`, and `presentation_mapping` take
the same objects by import, and `tests/test_tool_policy_contract.py` verifies that these names match the tools actually published by `.hermes/plugins`,
and requires any newly added bridge canvas write tool in a plugin to be classified explicitly.

The determination of raw Runtime Adapter events has been consolidated: the Hermes ACP shape (`sessionUpdate`, `toolCallId`, etc.) appears only in
`chat/hermes_events.py`, from which the adapter marks `lifecycle_only`,
`transient_failure`, `guard`, and `native_kind` on `ChatBackendEvent`; `chat.service` and the presentation/evidence modules consume only these fields.

## Observability and cleanup

Minimum metrics include pending commands, oldest age, delivery latency, lease steals, retry count,
dead letters, artifact verification failures, and projection lag. Cleanup tasks may only delete result payloads that are past TTL
and in a terminal state; command audit records are kept per the retention policy. When pending, delivered, or
accepted exceeds its TTL or retry limit, it must first become expired through CAS, with a dead letter and audit
reason written, and must not be deleted directly. Short lease timeouts of delivered/accepted are redelivered first according to the rules above.

Logs uniformly carry project_id, canvas_id, turn_id, run_id, action_id, command_id,
task_id, and product_operation_id, and recording secrets and full sensitive payloads is forbidden.

## Required tests

- After the browser closes, a server-owned Run continues or pauses explicitly.
- When two API workers compete for the same lease, only one succeeds.
- A duplicate ack from multiple tabs does not apply the mutation twice.
- The same command-level idempotency key with a different payload is rejected; the same payload returns the same command.
- Dead-letter replay gets a new command/key and replay_of but inherits the operation-level idempotency key; when an
  applied/settled result already exists, it does not write the Canvas or charge again.
- A delivered/accepted lease timeout redelivers with the same command, and after retries are exhausted it goes to expired/dead letter.
- A late result after applied/cancelled/failed/expired does not change the terminal state.
- A generation Action must not be completed when the Task is completed but the Artifact is missing.
- A Canvas/UI Action without a Task/Artifact can complete with an applied receipt and projection revision.
- A manual mainline Action must not be completed when the approval or business result receipt is missing.
- Old Recipe/Skill/Canvas JSON is restored through the migration layer.
- The Codex and Hermes adapters produce the same unified event sequence for the same fixture.

## Explicitly not executed in this design PR

- Do not switch the owner of existing Runs.
- Do not delete the file bridge or the browser runner.
- Do not introduce a Redis production dependency.
- Do not move large modules without contract tests.

These restrictions guarantee that merging the design itself does not change staging runtime behavior, and each later Phase is implemented in its own PR with a rollback
switch.
