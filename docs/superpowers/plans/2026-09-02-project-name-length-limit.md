# Project Name Length Limit Implementation Plan

> **For automated executors:** you must use `subagent-driven-development` (recommended) or `executing-plans` to execute task by task. This plan tracks progress with checkboxes.

**Goal:** Limit new project names to at most 64 characters, and unify the API schema, backend validation, frontend hint, and tests.

**Architecture:** The backend enforces the 64-character constraint separately in `ProjectCreate` and `validate_project_name()`; the frontend uses application-layer validation in the existing create-project dialog to show a localized error and disable creation. The frontend does not use the native `maxLength`, because it would truncate input, contradicting the confirmed interaction requirement.

**Tech stack:** Python, FastAPI, Pydantic, pytest, React, TypeScript, i18next, Vitest.

## Global constraints

- The maximum length is fixed at 64 characters.
- Allowed characters remain limited to `[A-Za-z0-9_]`, and the name cannot start with an underscore.
- When the schema rejects a request, FastAPI's 422 is kept; when the shared function rejects, it returns 400 and `Project name must be at most 64 characters long`.
- Over-long input must show an error, disable creation, and not truncate what the user has already typed.
- Duplicate-name detection and responses stay unchanged.

---

## File structure

- Modify `src/novelvideo/api/schemas.py`: declare the schema's maximum length.
- Modify `src/novelvideo/api/deps.py`: add the shared length validation.
- Create `tests/test_project_name_validation.py`: cover the schema, the shared function, and the HTTP entry.
- Modify `frontend/src/routes/_app/index.tsx`: add the frontend length validation.
- Modify `frontend/public/locales/en/translation.json` and `frontend/public/locales/vi/translation.json`: add the error text.
- Create `frontend/src/__tests__/routes/project-name-validation.test.tsx`: cover the frontend boundaries.
- Modify `docs/superpowers/specs/2026-09-02-project-name-length-design.md`: remove the `maxLength` wording and change it to application-layer validation.

### Task 1: Backend schema and shared validation

**Files:** `src/novelvideo/api/schemas.py:42-43`, `src/novelvideo/api/deps.py:136-149`, `tests/test_project_name_validation.py`.

- [ ] **Step 1: Write the failing tests**

```python
import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from novelvideo.api.deps import validate_project_name
from novelvideo.api.schemas import ProjectCreate

@pytest.mark.parametrize("name", ["a", "a" * 64, "project_01"])
def test_schema_accepts_valid_project_name_lengths(name):
    assert ProjectCreate(name=name).name == name

def test_schema_rejects_65_character_project_name():
    with pytest.raises(ValidationError, match="64"):
        ProjectCreate(name="a" * 65)

def test_shared_validator_rejects_65_character_project_name():
    with pytest.raises(HTTPException) as exc:
        validate_project_name("a" * 65)
    assert exc.value.status_code == 400
    assert exc.value.detail == "Project name must be at most 64 characters long"

@pytest.mark.parametrize("name", ["", "caf\u00e9", "has space", "has-dash", "has/slash", "_hidden"])
def test_shared_validator_keeps_existing_format_rules(name):
    with pytest.raises(HTTPException):
        validate_project_name(name)
```

- [ ] **Step 2: Confirm the tests fail**

Run `uv run pytest tests/test_project_name_validation.py -v`; expect the 65-character case to fail.

- [ ] **Step 3: Minimal implementation**

Change the model to:

```python
class ProjectCreate(BaseModel):
    name: str = Field(max_length=64)
```

Add before the format check in `validate_project_name()`:

```python
if len(name) > 64:
    raise HTTPException(status_code=400, detail="Project name must be at most 64 characters long")
```

- [ ] **Step 4: Verify and commit**

Run `uv run pytest tests/test_project_name_validation.py tests/ports/test_project_local_uniqueness.py -v`; expect all to pass and duplicate names to still return 409. Then run `git add src/novelvideo/api/schemas.py src/novelvideo/api/deps.py tests/test_project_name_validation.py && git commit -m "feat(api): limit project name length"`.

### Task 2: Frontend hint, no-truncation interaction, and translations

**Files:** `frontend/src/routes/_app/index.tsx:95,1170-1180,1330-1350`, the two translation JSON files, `frontend/src/__tests__/routes/project-name-validation.test.tsx`.

- [ ] **Step 1: Write the failing frontend unit tests**

Export `PROJECT_NAME_MAX_LENGTH` and `getProjectNameValidationKey()` from the route module, and write the tests as:

```tsx
import { describe, expect, it } from "vitest";
import { PROJECT_NAME_MAX_LENGTH, getProjectNameValidationKey } from "@/routes/_app/index";

describe("project name length validation", () => {
  it("accepts a 64-character name", () => {
    expect(PROJECT_NAME_MAX_LENGTH).toBe(64);
    expect(getProjectNameValidationKey("a".repeat(64))).toBeNull();
  });
  it("rejects a 65-character name", () => {
    expect(getProjectNameValidationKey("a".repeat(65))).toBe("project.nameTooLong");
  });
});
```

- [ ] **Step 2: Confirm the tests fail**

Run `cd frontend && npm test -- project-name-validation.test.tsx`; expect failure because the export does not exist.

- [ ] **Step 3: Minimal implementation and copy**

Add after `PROJECT_NAME_PATTERN`:

```tsx
export const PROJECT_NAME_MAX_LENGTH = 64;
export function getProjectNameValidationKey(name: string): string | null {
  if (name.length > PROJECT_NAME_MAX_LENGTH) return "project.nameTooLong";
  return !PROJECT_NAME_PATTERN.test(name) ? "project.nameInvalid" : null;
}
```

Make `createNameError` first obtain the translation from `getProjectNameValidationKey(trimmedNewName)`, then run the existing three duplicate-name branches; do not add `maxLength` to the `<Input>`. Add `nameTooLong` to the `project` translation node: in English `Project name must be at most 64 characters long.`, in Vietnamese `Tên dự án tối đa 64 ký tự.`

- [ ] **Step 4: Verify and commit**

Run `cd frontend && npm test -- project-name-validation.test.tsx locales-json.test.ts && npm run build`; expect the tests and the build to pass. Then run `git add frontend/src/routes/_app/index.tsx frontend/public/locales/en/translation.json frontend/public/locales/vi/translation.json frontend/src/__tests__/routes/project-name-validation.test.tsx && git commit -m "feat(ui): validate project name length"`.

### Task 3: HTTP contract and final verification

**Files:** `tests/contract/test_m02_projects.py:73-76`, `docs/superpowers/specs/2026-09-02-project-name-length-design.md`.

- [ ] **Step 1: Add the HTTP 422 contract test**

In the existing `with TestClient(app) as client:` block in `tests/contract/test_m02_projects.py`, right after the successful-creation assertion, call `client.post("/api/v1/projects", json={"name": "a" * 65})` and assert `status_code == 422` and that the response contains `64`; do not substitute a direct function call for the route test.

- [ ] **Step 2: Sync the design note**

In the spec, change "add `maxLength` to the input" to "application-layer length validation; do not truncate input", so that it matches the confirmed interaction.

- [ ] **Step 3: Run the full verification and commit**

Run `uv run pytest` and `cd frontend && npm run build`; expect both to succeed. Finally run `git add tests/contract/test_m02_projects.py docs/superpowers/specs/2026-09-02-project-name-length-design.md && git commit -m "test: cover project name length boundaries"`.
