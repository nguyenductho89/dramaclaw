# Scene and Prop Planning for Line-by-Line Scripts

When generating a line-by-line script, the shared workflow first fills in the scene and prop menus missing from the episode, then generates metadata for each shot. Planning uses the actual script input of this run, and preserves the saved source text and any menus the user already has. SQLite checks for emptiness atomically at write time, so selections the user makes during planning are also preserved. A scene is matched only by a unique name or exact alias within the episode's scope; ambiguous matches stay unselected.

When scenes are re-planned later, the workflow can fill in empty scene references on generated shots whose origin is known. A generated shot records the SHA256 of the input it was actually generated from; if the index, count, or digest does not match, nothing is backfilled. Existing scene selections, manually created shots, and legacy shots without a source digest are left as they are. Editing the visual description or narration clears the source marker, so a shot the user has modified is not mistaken for an original generated result and re-aligned.

The project SQLite migration version goes from 4 to 5, adding a `source_text_sha256` column that defaults to empty for old records. The migration does not regenerate scripts. The frontend refreshes the episode details, shots, script, scene, prop, and reference caches when synchronous planning and background tasks finish.

A narration script with no physical locations may be planned into an empty scene menu. Analysis failures and legitimately empty results are handled separately; when the rules cannot determine the scene, an analysis failure is still reported as an error. When an empty allowed set is passed explicitly, the generated result must not keep scenes, characters, or props outside that set.

The script's visual descriptions are used for shot generation. Video prompt generation still requires generating or selecting a sketch / first-frame image first, then running automatic prompt generation.

## Optional Text Model Budget

When `NEWAPI_TEXT_CONTEXT_TOKENS` is not configured, request behavior is unchanged. When it is configured, the client computes a conservative budget for the text, tools, and output structure before sending both regular and streaming requests, and reserves output tokens; this includes the validation retry history. An insufficient budget raises an explicit error, and the source text is never truncated.

The context budget should be set according to the actual gateway model window, and must be greater than the output budget plus 1024. `NEWAPI_TEXT_OUTPUT_TOKENS` defaults to 8192 and can be overridden by the request's output limit. URLs / Base64 inside explicitly typed image content are not counted as text; vision tokens are validated by the provider, so this check is not an upper bound on text plus vision combined.

## Test Environment Isolation

- The reload test for the port registry module restores both the registry state and the exception class identity at the end, so exception handling in already imported consumers keeps working.
- The graph database lifecycle test replaces only the install / load commands of the JSON extension; core queries, read/write switching, thread-cancellation waits, and lock release still use the native database. Extension install success and failure are tested separately and do not depend on the availability of the extension download server.
- The Node-environment local storage compatibility object uses a consistent constructor and prototype, so quota-exceeded simulation can intercept actual writes.
- The upload error test uses a matching native File / FormData, and verifies backend error propagation after checking the file name, byte count, and content.
