# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Scope guard for media references on a canvas.

Static assets are authorized independently by the project id in the URL, but canvas saves never looked at it: a canvas can store media addresses that point to
**another project**; the source project owner opens it fine, while another equally legitimate project member gets a wall of
403 broken images -- projects can be shared, internal dependencies cannot.

This module does one thing: scan the media references out of a canvas payload; any whose project id in the URL differs from the canvas's own project
is a foreign-project reference. The check does not distinguish personal / organization, so even the source project owner cannot bypass it.

The guard only blocks references that are newly introduced by this save: stale dirty references already in storage pass as before, otherwise one dirty node could lock an entire
old canvas for good (those canvases are exactly the victims of the problem this guard solves). Historical data converges through read-time diagnostics
(the reference list returned with `GET`) and manual copying by users.
"""

from __future__ import annotations

import posixpath
import re
from dataclasses import dataclass
from typing import Iterator
from urllib.parse import urlsplit

from novelvideo.freezone.asset_copy import parse_project_asset_url
from novelvideo.freezone.canvas_static_urls import is_url_field_name

# When a browser fetches a resource it does not care whether scheme/host are fully written, and it normalizes `..` first. `parse_project_asset_url`
# is the entry parser of the copy endpoint and only accepts the relative canonical form (deliberate: external URLs must not be treated as local files there).
# If the two sides disagree, the guard leaks: `/static/projects/target/../source/a.png` is allowed as target while the browser
# actually fetches source. So the URL is restored to the site path as the browser sees it before scanning.
_LOCAL_URL_SCHEMES = {"", "http", "https"}


@dataclass(frozen=True)
class ForeignMediaRef:
    """A media reference that points at another project."""

    node_id: str
    """Id of the offending node."""
    field: str
    """Field path inside the node `data`, e.g. `cells[1].imageUrl`."""
    url: str
    """Raw URL in the payload (including the query string; the frontend rewrites by the original string)."""
    source_project_id: str
    """Project the URL points to."""

    def as_dict(self) -> dict[str, str]:
        return {
            "node_id": self.node_id,
            "field": self.field,
            "url": self.url,
            "source_project_id": self.source_project_id,
        }


class CanvasMediaScopeError(Exception):
    """The canvas tried to persist a media reference outside this project."""

    def __init__(self, refs: list[ForeignMediaRef]):
        super().__init__(f"canvas media scope mismatch: {len(refs)} foreign reference(s)")
        self.refs = refs


def scan_foreign_media_refs(payload: dict | None, *, project_id: str) -> list[ForeignMediaRef]:
    """List all media references in the payload that do not belong to `project_id`, in node and field order."""
    return list(_iter_foreign_refs(payload, project_id=project_id))


def reject_new_foreign_media_refs(
    payload: dict | None,
    *,
    existing: dict | None,
    project_id: str,
) -> None:
    """Raise if this save newly introduces a foreign-project reference; those already in storage pass unchanged."""
    incoming = scan_foreign_media_refs(payload, project_id=project_id)
    if not incoming:
        return
    grandfathered = {
        _asset_identity(ref.url) for ref in scan_foreign_media_refs(existing, project_id=project_id)
    }
    # The `?v=` of the same file may be restamped on every read, so identify by "project + project-relative path", not by the whole string.
    new_refs = [ref for ref in incoming if _asset_identity(ref.url) not in grandfathered]
    if new_refs:
        raise CanvasMediaScopeError(new_refs)


def _site_path(url: str) -> str | None:
    """Restore a URL to the site path the browser would actually fetch; return `None` if it is not a site resource.

    Only the path is kept: `data:` / `blob:` are not site files and are rejected outright; a full URL with a host is classified by its path
    (the cost is that an external URL whose path looks exactly like a project resource is also treated as one -- better to block by mistake than to let through a
    URL the browser would fetch as a project resource).
    """
    try:
        parts = urlsplit((url or "").strip())
    except ValueError:
        # Malformed URLs such as `http://[`: urlsplit itself blows up; they are not site resources either.
        return None
    if parts.scheme.lower() not in _LOCAL_URL_SCHEMES or not parts.path:
        return None
    # `%2e%2e` is also a dot-dot segment per the URL spec and browsers still use it to go up one level; only restore the dots, do not unquote the whole string
    # (`%2f` is not a separator, and unquoting the whole string would split the path wrongly).
    return posixpath.normpath(re.sub("%2e", ".", parts.path, flags=re.IGNORECASE))


def _parse_media_url(url: str) -> tuple[str, str] | None:
    path = _site_path(url)
    return parse_project_asset_url(path) if path is not None else None


def _asset_identity(url: str) -> tuple[str, str] | str:
    parsed = _parse_media_url(url)
    return parsed if parsed is not None else url


def _iter_foreign_refs(payload: dict | None, *, project_id: str) -> Iterator[ForeignMediaRef]:
    if not isinstance(payload, dict):
        return
    nodes = payload.get("nodes")
    if not isinstance(nodes, list):
        return
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            continue
        node_id = str(node.get("id") or f"#{index}")
        data = node.get("data")
        if not isinstance(data, (dict, list)):
            continue
        yield from _iter_foreign_values(data, node_id=node_id, path="", project_id=project_id)


def _iter_foreign_values(
    value: object,
    *,
    node_id: str,
    path: str,
    project_id: str,
    key: str | None = None,
) -> Iterator[ForeignMediaRef]:
    if isinstance(value, dict):
        for child_key, child in value.items():
            child_key = str(child_key)
            child_path = f"{path}.{child_key}" if path else child_key
            yield from _iter_foreign_values(
                child,
                node_id=node_id,
                path=child_path,
                project_id=project_id,
                key=child_key,
            )
        return
    if isinstance(value, list):
        for index, child in enumerate(value):
            yield from _iter_foreign_values(
                child,
                node_id=node_id,
                path=f"{path}[{index}]",
                project_id=project_id,
                key=key,
            )
        return
    if not isinstance(value, str) or not is_url_field_name(key):
        return
    parsed = _parse_media_url(value)
    if parsed is None:
        return
    source_project_id, _rel = parsed
    if source_project_id == project_id:
        return
    yield ForeignMediaRef(
        node_id=node_id,
        field=path,
        url=value,
        source_project_id=source_project_id,
    )
