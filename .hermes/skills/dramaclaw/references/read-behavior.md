# Read Behavior

The goal of a read-only request is to **satisfy the result the user wants first**, rather than first explaining how the query is done.

## Applicable scenarios

- Project list
- Task list / task overview
- Character list / character details
- Identity name list
- Current status or fact query of some object
- Ingest files already uploaded to the current project

## Default handling principles

- If the user wants a list, give the list result first.
- If the user wants facts about an object, give the facts about the object first.
- If the user says "just list / that's enough / just tell me the result", stop at the result itself.
- Unless the user explicitly wants the process, the basis, limitations or next-step advice, do not first elaborate on what you will check, confirm or locate.
- Default to a single wrap-up: reply once after getting the result, and do not live-broadcast preparation actions to the user during the query.

## List reads

- Project list: first give the number of projects and the list of project names.
- Task list: first give an overview of running / queued / completed tasks.
- Identity name list: first give the list of names.
- Character list: extract only the identifying information most useful to the user and do not restate the whole object structure.

If the result is empty, just say it is empty; do not first describe the query action.

### Uploaded files

- When the user asks "which files were uploaded / the currently uploaded files / what was just uploaded / the uploaded screenplay", call `dramaclaw_list_ingest_uploads` and treat the returned `files` as the source of truth.
- When the current message contains `[DRAMACLAW_UPLOADED_FILES]`, it can be used to describe the immediate result of the just-completed upload, but ingest or overwrite must not be started automatically from it.
- Do not guess files from conversation history, do not scan the filesystem, and do not treat the historical upload directory as the current message's attachment.

### R1 default opening for list reads

For low-ambiguity read-only requests such as the project list and the task list, the first paragraph visible to the user should go straight to the result; do not first state "checking per the flow", "reading the instructions first" or "confirming the query method first".

Recommended default templates:

- Project list: `There are currently N projects: ...`
- Task list: `There are currently N unfinished tasks: ...` or `The current task overview is as follows: ...`

There is no need to write first:

- Which flow you will use to check
- Which instruction or reference you will read first
- Which endpoint or query method you will confirm first
- Which kind of read scenario you have classified the request as

### Default granularity of list reads

- Project list: number of projects + project names.
- Task list: status distribution + key tasks that are running or queued.
- Identity name list: the name list; when the user says "that's enough", end there.
- Character list: prefer key information such as `name`, whether protagonist, and whether a portrait exists.

## Detail reads

- First answer what state the object the user asked about is currently in and which key fields it has.
- Add only the minimum necessary information directly related to the question.
- Do not restate full JSON, endpoints, paths or raw responses to the user.

### Default response trimming rules

- Character list: by default extract only `name`, `is_main`, `portrait_url`
- Beat list: by default extract only `beat_number` and a minimal content summary
- Task status: by default extract only `status` and, when necessary, a one-sentence progress note
- Never restate full JSON directly to the user

## When to add an explanation

Add one sentence of explanation only in these cases:

- The result is empty
- The current endpoint does not have enough information
- The user's request itself is ambiguous
- The user explicitly asks "why / how to judge / what is the basis"

## Prohibited

- Do not first say "let me check first / let me confirm first / let me locate first / I'll go read the reference / I have switched to the query path"
- For R1 list reads, do not first say "let me check per the flow / let me read the instructions / let me confirm the query method / I have confirmed this is a read-only request"
- Do not live-broadcast the query process to the user
- Do not output technical details, JSON or endpoint paths as part of the result
- Do not visit documentation pages, the root path or unrelated endpoints for a second confirmation of a read request
