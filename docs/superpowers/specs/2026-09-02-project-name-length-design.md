# Project Name Maximum Length Validation

## Goal

Limit new project names to at most 64 characters, while keeping the current format rules and duplicate-name validation behavior unchanged. The API
contract, backend validation, and the create-project dialog must enforce the same length limit.

## Scope of changes

- Enforce the 64-character maximum through both route input validation and shared validation, so the API contract and application-layer behavior stay consistent.
- Enforce the same maximum-length validation in `validate_project_name()`, to prevent future or non-route callers from bypassing the rule.
- Keep the existing allowed character set (`[A-Za-z0-9_]`) and the rule "cannot start with an underscore".
- The home-page create-project input performs the length validation at the application layer without truncating input. The user can keep typing a name longer than 64 characters, but the dialog immediately shows a localized error and disables the "Create" button.
- Add backend and frontend automated tests covering the 1, 64, and 65 character boundaries, the existing illegal formats, and duplicate-name regression behavior.

## API behavior

The route input model limits the name length to 64. FastAPI rejects over-long requests before the route runs, keeping the framework's standard 422 validation response.
When `validate_project_name()` receives an over-long name, it returns HTTP 400 with the stable message: `Project name must be at most 64 characters long`.

The two layers keep their own normal error response structures, but use the same 64-character rule and client-facing message. Duplicate-name detection and responses are not modified.

## Frontend behavior

The create-project dialog keeps the current logic of "trim leading and trailing spaces before submitting". The length validation is also performed on the trimmed name, and together with the current format and duplicate-name validation decides the error state. When the name reaches 65 characters, a localized maximum-length hint is shown, `aria-invalid` is set, and the "Create" button is disabled; what the user has already typed is not truncated.

## Verification

- Backend tests confirm that valid names of 1 and 64 characters pass, and that a 65-character name is rejected by both the schema and the shared validation function.
- Keep the existing tests for illegal characters, leading underscores, and duplicate names passing, to prove the original behavior has not regressed.
- Frontend tests cover the 64-character boundary, the localized error hint when the length is exceeded, and the "Create" button being disabled.
