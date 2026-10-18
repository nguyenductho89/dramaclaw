# Chat Presentation Mapping Boundary (#559 Phase 2)

This phase is a compatibility migration. It does not change approval order, tool execution, model lists, or generation parameters.
It does not mean #559 is fully complete, and it does not replace the structured execution-evidence validation of #575.

## Responsibilities already moved out

`chat/presentation.py` depends only on the Python standard library and handles the canonical UI-spec:

- JSON tail repair and validation, including compatibility with existing legacy component props;
- UI-spec JSON / block / bundle packaging and the separation of body text from cards;
- merging media cards by existing category, renaming conflicting keys, and de-duplication.

The remaining conversions on the chat presentation path have also been split out:

- `chat/presentation_text.py` handles history replay de-duplication, streaming text merging, path masking, and body text cleanup;
- `chat/presentation_mapping.py` handles UI-spec normalization, tool result display/error mapping, and prompt filtering;
- `chat/media_presentation.py` handles message media link extraction, normalization, and de-duplication;
- `chat/display_fallback.py` reads authoritative media details and assembles display cards; it carries its own read-only HTTP GET
  (base URL taken from an environment variable), `open_url` is injected by the Application, and tests intercept requests by replacing that callback.

`service.py` keeps the old function entry points, project directory resolution, error log writing, API read injection, and event
sending order. The presentation modules hold no session, database, or canvas write state.

The dependency direction is `chat/service.py -> chat/presentation.py -> Python standard library`.
The presentation modules must not import the Application, Runtime Adapter, Session Registry, database,
model SDKs, or API clients. `tests/test_chat_presentation.py` guards the boundary with a dependency-constraint test.

Error logging is injected by the Application through the `log_error` callback; the presentation modules do not choose file paths,
do not read project identity, and do not write log files. `service.py` keeps the old helper names and two thin delegates,
so existing callers can migrate gradually. The original ordering, error messages, and illegal-card skipping policy are unchanged.

This migration was done mechanically with the original algorithm and did not incidentally fix historical semantics such as nested card merging; such behavior changes should be
committed separately with regression tests and fixes, and must not be mixed into the structural split.

## Verification strategy

Before migration, run the existing JSON-render / UI-spec characterization tests; after migration, verify both
the new modules and the old entry points. Coverage includes legacy props, input immutability, JSON repair, illegal references, bundle
round trips, category order, merging, de-duplication, and Application log callback compatibility.
Then run the full backend regression and the Workflow generation contract check.

## Remaining #559 boundaries (not yet complete)

1. `chat/runtime_event_evidence.py` has moved out of the Application the
   pure parsing of Freezone tool results, canvas write receipt validation, pre-validation failures, and retry identity computation; `service.py` temporarily keeps the old
   helper exports for existing callers. `chat/runtime_event_mapper.py` has unified the lifecycle, progress, and SDK tool event outbound payloads of the three runtime
   streams, as well as the lifecycle determination of raw Hermes tool updates; event send timing is still managed by the Application. From the fifth phase on, knowledge of the Hermes ACP shape
   lives only in `chat/hermes_events.py`; when the adapter translates `session/update`, it stamps four provider-neutral fields on `ChatBackendEvent`:
   `native_kind`, `lifecycle_only`, `transient_failure`, and `guard`;
   `service.py` reads only these fields and no longer inspects `sessionUpdate` or the raw guard dict.
   The old helpers in `runtime_event_mapper` / `presentation_mapping` remain as delegating entry points.
   `tests/test_hermes_events.py` scans that application modules must not contain ACP-shaped fields.
   `chat/runtime_history.py` has taken over the pure parsing of native Codex history entries into chat records;
   history reading, timestamps, media completion, and cache writes are still handled by `service.py`.
   A subsequent standalone fix added SDK `UserInput.root` expansion, to avoid
   missing user messages when reading native thread history; that fix does not change the current-turn message write path.
   The tool-name policy sets have been consolidated into `chat/tool_policy.py` (fourth phase); the Hermes adapter's canvas write
   set was completed with `freezone_confirm_canvas_action`, so that confirmation calls extend the idle
   timeout like other bridge writes, and `tests/test_tool_policy_contract.py` guards consistency with the plugin tool names.
2. The chat presentation conversion and the display tool fallback have been moved out; when adjusting presentation behavior later, continue to treat
   the canonical UI-spec boundary of `presentation.py` and the authoritative media API as the reference.
3. The Session Registry / Delivery Evidence are independent, following the run identity and durable bridge constraints of #555 / #558,
   and coordinated with the #575 execution-evidence contract.
   `chat/session_registry.py` has taken over lock scope, record parsing, expiry determination, file preemption,
   heartbeat and release, as well as the file format, reading/writing, and scope keys for Agent/Codex session state and active turns.
   `service.py` keeps path selection, protocol version, atomic writes and file-lock injection, and the existing entry points.
   The migration of the old project chat database, table creation, message and settings read/write, trajectory replacement, and the input history file
   have moved to `chat/message_repository.py`; path selection, message media completion, and presentation remain in the
   Application. The new scoped chat storage is still handled by `chat/store.py`.
4. Freezone routes are extracted domain by domain: Canvas, Catalog, Workflow, ProductOperation, Asset;
   each domain first fixes compatibility tests, then keeps the old route as a thin delegate.
5. The large frontend orchestration module continues to be split; the stable Workflow contract continues to use the generated source of #572,
   and the dynamic model catalog stays read at runtime and must not be baked into the generated contract.

#559 should be closed only after all of the above boundaries and the acceptance conditions of the original issue are verified.
