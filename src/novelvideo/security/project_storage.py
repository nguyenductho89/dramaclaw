"""Unified ownership validation of project storage directories.

Every move or delete of the **whole tree** of a project's output/state/runtime must go through this module first.
Goal: even if database records are tampered with, an old migration wrote bad paths, or a program defect makes paths abnormal, files belonging to
other users (or broad directories such as the data root or user root) can never be moved or deleted.

The canonical layout is ``<root>/<owner_username>/<project>`` or
``<root>/_orgs/<organization>/<owner_username>/<project>``, where the three kinds of root
are ``config.OUTPUT_DIR`` / ``config.STATE_DIR`` / ``config.RUNTIME_DIR`` respectively.

Validation rules (reject if any is not satisfied; the caller must give up moving/deleting any directory):

1. The path must exactly match the owner, project, and organization scope frozen in the project record;
2. Each of the three directory kinds may only fall inside its corresponding data root;
3. No storage boundary level below the root may be a symlink
   (to prevent a symlink in a writable directory from redirecting deletion elsewhere);
4. The path must not equal the data root or the owner user root;
5. The three directories must be distinct from each other and none may be an ancestor of another.
"""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path

from novelvideo import config


class ProjectStorageOwnershipError(Exception):
    """The project storage directories failed ownership validation; moving or deleting is forbidden."""


@dataclass(frozen=True, slots=True)
class ValidatedProjectStorage:
    """The three directory kinds after validation (all resolved real paths)."""

    output_dir: Path
    state_dir: Path
    runtime_dir: Path

    def as_tuple(self) -> tuple[Path, Path, Path]:
        return (self.output_dir, self.state_dir, self.runtime_dir)


def _roots() -> dict[str, Path]:
    # Read dynamically rather than bound at import time: the root directories can be reconfigured or rewritten by tests.
    return {
        "output": Path(config.OUTPUT_DIR),
        "state": Path(config.STATE_DIR),
        "runtime": Path(config.RUNTIME_DIR),
    }


def _safe_segment(value: str | None, *, label: str) -> str:
    segment = (value or "").strip()
    if (
        not segment
        or segment != value
        or segment in {".", ".."}
        or "/" in segment
        or "\\" in segment
    ):
        raise ProjectStorageOwnershipError(f"invalid {label}: {value!r}")
    return segment


def _expected_suffix(
    *,
    owner_username: str,
    project_name: str,
    storage_org_id: str | None,
    storage_org_name: str | None,
) -> tuple[str, ...]:
    owner = _safe_segment(owner_username, label="owner username")
    project = _safe_segment(project_name, label="project name")
    if storage_org_id is None and storage_org_name is None:
        if owner == "_orgs":
            raise ProjectStorageOwnershipError(
                "personal project owner collides with reserved organization namespace"
            )
        return (owner, project)
    if storage_org_id is None or storage_org_name is None:
        raise ProjectStorageOwnershipError(
            "organization storage id and name must either both be set or both be absent"
        )
    _safe_segment(storage_org_id, label="organization storage id")
    org_name = _safe_segment(storage_org_name, label="organization storage name")
    if owner == "_system":
        raise ProjectStorageOwnershipError(
            "organization project owner collides with reserved system namespace"
        )
    return ("_orgs", org_name, owner, project)


def _absolute_without_symlink_resolution(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def _validate_one(kind: str, root: Path, suffix: tuple[str, ...], raw: Path) -> Path:
    root_absolute = _absolute_without_symlink_resolution(root)
    # Configuration roots are trusted and may contain symlinks. Registry paths
    # may retain that spelling or already be canonical (default_project_dirs).
    # Resolve only the root here: resolving raw would hide boundary symlinks.
    root_real = root_absolute.resolve(strict=False)
    expected = root_real.joinpath(*suffix)
    raw_absolute = _absolute_without_symlink_resolution(raw)
    if raw_absolute not in (expected, root_absolute.joinpath(*suffix)):
        raise ProjectStorageOwnershipError(
            f"{kind}: path {raw_absolute} does not match expected project path {expected}"
        )

    current = root_real
    for segment in suffix:
        current = current / segment
        if current.is_symlink():
            raise ProjectStorageOwnershipError(
                f"{kind}: storage boundary {current} is a symlink; refusing"
            )

    real = raw_absolute.resolve(strict=False)
    if real != expected:
        raise ProjectStorageOwnershipError(
            f"{kind}: resolved path {real} escaped expected project path {expected}"
        )
    return real


def _assert_disjoint(paths: dict[str, Path]) -> None:
    items = list(paths.items())
    for i, (kind_a, a) in enumerate(items):
        for kind_b, b in items[i + 1 :]:
            if a == b:
                raise ProjectStorageOwnershipError(
                    f"{kind_a} and {kind_b} resolve to the same directory {a}"
                )
            if a in b.parents or b in a.parents:
                raise ProjectStorageOwnershipError(
                    f"{kind_a} ({a}) and {kind_b} ({b}) are nested"
                )


def assert_owned_project_storage(
    *,
    owner_username: str,
    project_name: str,
    storage_org_id: str | None = None,
    storage_org_name: str | None = None,
    output_dir: str | Path,
    state_dir: str | Path,
    runtime_dir: str | Path,
) -> ValidatedProjectStorage:
    """Validate ownership of the three project directory kinds; return resolved real paths on success, otherwise raise.

    The caller must move/delete the returned paths only after this function returns successfully; if any validation fails, no
    destructive operation may be performed on any directory.
    """
    suffix = _expected_suffix(
        owner_username=owner_username,
        project_name=project_name,
        storage_org_id=storage_org_id,
        storage_org_name=storage_org_name,
    )
    roots = _roots()
    validated = {
        "output": _validate_one("output", roots["output"], suffix, Path(output_dir)),
        "state": _validate_one("state", roots["state"], suffix, Path(state_dir)),
        "runtime": _validate_one(
            "runtime", roots["runtime"], suffix, Path(runtime_dir)
        ),
    }
    _assert_disjoint(validated)
    return ValidatedProjectStorage(
        output_dir=validated["output"],
        state_dir=validated["state"],
        runtime_dir=validated["runtime"],
    )


__all__ = [
    "ProjectStorageOwnershipError",
    "ValidatedProjectStorage",
    "assert_owned_project_storage",
]
