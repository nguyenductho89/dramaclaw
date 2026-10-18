# Async Tasks

The goal of async tasks: **start, observe or continue a task as the user requests, and report to the outside with the minimum necessary state.**

## Applicable scenarios

- Starting an async task
- Checking the current progress
- Tracking continuously until completion
- Resuming a wait from a breakpoint

## Default policy

- When the user only says "start it and check the current progress", do a one-shot status check and do not automatically escalate to continuous tracking.
- When the user explicitly asks to "keep watching / follow live / watch until done", still only observe the current task status; never start the next step after the task completes.
- When the current status is not `completed`, tell the user the current status clearly; do not compress it into "done".
- The final reply of a long task keeps by default only "what was done / current status / next step", and does not string interim troubleshooting steps into an external log.
- Whenever any async task is `queued` / `running` / `pending`, this turn only reports "background generation is in progress" and the current task status; never start the next step that depends on it.

## One-shot status query

The default output keeps only:

1. Whether it has started
2. Current status/progress
3. One sentence of next-step advice when necessary

Do not string preparation actions, endpoint confirmations and retry deliberation into a user-facing log.

### One-shot default path

- Before starting, check whether a task of the same kind or a dependent task is queued/running/pending; if so, report that the task is in progress and stop
- Only when there is no running task, start the one task corresponding to the current request
- If the start endpoint returns `ok:false`, a non-2xx HTTP status, or an explicit `error` in the response, immediately report a summary of that error text to the user and do not say "started"
- Query the corresponding task status once more
- If this query still returns `queued` / `running` / `pending`, wrap up with the current status; do not keep polling until completion and do not start the next step
- If this query returns `failed` / `cancelled`, you must report the most direct one-sentence failure reason from `task.error`, `error_code` or `logs` to the user; do not compress it into "started" or "redone"
- If the task status is already sufficient, reply directly from it
- Only when the task status is not enough to explain the current stage, add one global status explanation
- For task-management requests such as cancel/clean up: confirm the status using only `GET /api/v1/projects/{project}/tasks` and `GET /api/v1/projects/{project}/tasks/{type}/{episode}`, and at most one extra `GET /api/v1/projects/{project}/pipeline/status` if necessary
- Do not probe `GET /api/v1/projects/{project}/status`; it is not a currently available task status route
- **Task status routes are all under `/api/v1/projects/{project}/tasks/`**; do not probe the top-level `/api/v1/tasks/...`, the current backend has no such route.

### One-shot output template

- `Started <task name>.`
- `Current status: <queued/running/completed/failed/cancelled>`, with one sentence about progress or limitations when necessary
- On failure: `Failure reason: <task.error or endpoint error>`
- `If you like, I can check the progress again later; execute the next step after the current task completes.`

## Continuous observation

- Use only when the user explicitly asks for continuous tracking
- During continuous observation, at most 4 status queries per turn; stop immediately once `completed` / `failed` / `cancelled` is obtained
- Toward the user, show only natural-language progress, not raw JSON
- After the task completes, wrap up with the result status; do not recount the whole observation process and do not start the next step
- Status queries use only the DramaClaw plugin tools; do not call shell, curl or local scripts to parse responses.

## Recovery and conflicts

- Recovering an existing project: see `playbooks/resume.md` first
- Task conflicts: query the current status first, then decide whether to wait, resume or retry
- Without new facts, do not retry blindly
- For one-shot requests, do not repeatedly mix multiple status lines "to be safer", and do not go read the API documentation page for a second confirmation

## Boundaries after a single-beat task completes

- **Single-beat video redo** (`single_video`): within one user request, send the redo POST for the same beat only once. After POST returns 2xx and `ok`/`generated: true`, wrap up directly with the started or currently queried task status; do not POST again because the task query returns `Task not found`, a missing task status or no `result.video_path`. **If the same `single_video` task is later found `failed` / `cancelled`, you must report the failure reason (for example insufficient credits, upstream rejection, download failure), and must not say it is done/redone.** Do not trigger whole-episode compose/generate/optimize just to get the video file, and do not guess file download paths.
- If the `single_video` status does not return `result.video_path`, do not probe `/files` and do not probe `/api/v1/projects/{project}/files`; wrap up only according to started / current status.
- **Single-beat audio redo**: returns synchronously; just tell the user it is done.
- Principle: the scope of a single-beat operation is that beat; do not escalate it to a whole-episode operation.
- **Scene anchor image generation**: **not an async task**. The current backend has no `/scenes/{name}/anchor-image/*` route and no `scene_anchor` task type; do not call anchor-image generation or query paths.

## Checkpoint exception handling

- If the async task status shows `completed`, but the core artifact the checkpoint should deliver is still empty:
  - First treat it as an **abnormal breakpoint**
  - Directly report to the user "the task completed but the artifact is empty / not reviewable"
  - By default stop at the current checkpoint
- Within the same continuation / checkpoint request:
  - Do not automatically re-trigger the same generation step
  - Do not manually fill in the core content that the generation step should have produced
  - Do not disguise the abnormal breakpoint as "the checkpoint was reached normally"
- Only when the user explicitly asks to continue remediation, rerun, or switch to a manual plan do you enter the next remediation action in a later turn
