"""Cross-project paste: the backend copies source-project files into the target project, and the frontend no longer "downloads once and uploads once".

The previous chain was the browser fetching the source project `/static/projects/<src>/...` and then POSTing it to the target project's
`freezone/upload`: bytes moved twice, big videos had a long window, and the backend did not know at all that this was a cross-project
copy, so there was no ownership validation whatsoever. Now the frontend only reports "copy these URLs to the current project", and the backend:

- parses the URL to get the source project id and the project-relative path (only the same-origin canonical form is accepted);
- validates viewer on the source project and editor on the target project;
- prefers having OSS do a server-side CopyObject (bytes do not go through the pod), and when OSS is unavailable / the object is not ready /
  the copy is not visible on the mount afterwards, falls back to a filesystem copy;
- returns the mapping from old URL to new URL, where a single failure is recorded only into `failed` and does not drag down the whole batch.
"""

from __future__ import annotations

import hashlib
import time
from pathlib import Path
from types import SimpleNamespace

from oss2.utils import Crc64

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from novelvideo import config
from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.api.schemas import FreezoneAssetCopyRequest
from novelvideo.freezone import asset_copy
from novelvideo.ports.project import require_role_value
from novelvideo.project_context import ProjectContext
from novelvideo.utils import oss_client

# ---------------------------------------------------------------------------
# URL parsing
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        (
            "/static/projects/proj_a/freezone/_uploads/a.png?v=123",
            ("proj_a", "freezone/_uploads/a.png"),
        ),
        ("/static/projects/proj%20a/dir/b%20c.mp4", ("proj a", "dir/b c.mp4")),
        ("/static/projects/proj_a/dir/c.png#frag", ("proj_a", "dir/c.png")),
        ("/api/v1/projects/proj_a/media/dir/c.png", ("proj_a", "dir/c.png")),
    ],
)
def test_parse_project_asset_url_accepts_canonical_same_origin_forms(url, expected):
    assert asset_copy.parse_project_asset_url(url) == expected


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example/static/projects/proj_a/x.png",
        "//evil.example/static/projects/proj_a/x.png",
        "http://[",
        "http://[::1/static/projects/proj_a/x.png",
        "/static/alice/demo/legacy.png",
        "/static/projects/proj_a",
        "/static/projects/proj_a/",
        "/static/projects/proj_a/dir\\x.png",
        "/static/projects/proj_a/freezone/_uploads/bad%00.png",
        "/static/projects/proj%00a/freezone/_uploads/x.png",
        "/static/projects/proj_a/freezone/_uploads/x%0a.png",
        "/api/v1/projects/proj_a/files/x.png",
        "data:image/png;base64,AAAA",
        "blob:https://app.example/abc",
        "",
        "   ",
    ],
)
def test_parse_project_asset_url_rejects_everything_else(url):
    assert asset_copy.parse_project_asset_url(url) is None


# ---------------------------------------------------------------------------
# Source file location (guarding against directory traversal)
# ---------------------------------------------------------------------------


def test_resolve_source_file_rejects_paths_escaping_the_project(tmp_path: Path):
    project_dir = tmp_path / "output" / "alice" / "demo"
    (project_dir / "freezone").mkdir(parents=True)
    (tmp_path / "output" / "secret.txt").write_bytes(b"nope")

    with pytest.raises(asset_copy.AssetCopyError) as excinfo:
        asset_copy.resolve_source_file(project_dir, "../secret.txt")
    assert excinfo.value.reason == "invalid_source"


def test_resolve_source_file_rejects_missing_or_non_regular_files(tmp_path: Path):
    project_dir = tmp_path / "output" / "alice" / "demo"
    (project_dir / "freezone").mkdir(parents=True)

    with pytest.raises(asset_copy.AssetCopyError) as missing:
        asset_copy.resolve_source_file(project_dir, "freezone/nope.png")
    assert missing.value.reason == "not_found"

    with pytest.raises(asset_copy.AssetCopyError) as directory:
        asset_copy.resolve_source_file(project_dir, "freezone")
    assert directory.value.reason == "not_found"


def test_resolve_source_file_turns_path_errors_into_per_source_failures(tmp_path: Path):
    """Path-level exceptions such as null bytes and over-long file names also count as only this one failure, and must not blow up the caller."""
    project_dir = tmp_path / "output" / "alice" / "demo"
    (project_dir / "freezone").mkdir(parents=True)

    with pytest.raises(asset_copy.AssetCopyError) as null_byte:
        asset_copy.resolve_source_file(project_dir, "freezone/bad\x00.png")
    assert null_byte.value.reason == "invalid_source"

    with pytest.raises(asset_copy.AssetCopyError) as too_long:
        asset_copy.resolve_source_file(project_dir, "freezone/" + "x" * 300 + ".png")
    assert too_long.value.reason in {"invalid_source", "not_found"}


# ---------------------------------------------------------------------------
# Target naming
# ---------------------------------------------------------------------------


def test_allocate_target_path_bounds_the_filename_length(tmp_path: Path):
    """A 234-byte source file name is legal by itself, but adding the timestamp prefix exceeds 255; truncate it rather than let exists() blow up."""
    long_name = "x" * 230 + ".png"
    target = asset_copy.allocate_target_path(tmp_path, long_name)

    assert target.parent == tmp_path
    assert not target.exists()
    assert target.name.endswith(".png")
    assert len(target.name.encode()) <= 255
    # The truncated original name follows right after the timestamp prefix.
    assert target.name.split("_", 3)[3].startswith("xxxxxxxx")


def test_allocate_target_path_keeps_short_names_intact(tmp_path: Path):
    target = asset_copy.allocate_target_path(tmp_path, "clip.mp4")
    assert target.name.endswith("_clip.mp4")


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("a.png", "a.png"),
        ("x" * 124 + ".png", "x" * 116 + ".png"),
        ("x" * 200, "x" * 120),
        ("x" * 200 + "." + "y" * 40, "x" * 120),
        ("", "upload"),
    ],
)
def test_bounded_upload_basename(name, expected):
    assert asset_copy.bounded_upload_basename(name) == expected


# ---------------------------------------------------------------------------
# Copy: OSS direct copy first, filesystem fallback
# ---------------------------------------------------------------------------


class _FakeBucket:
    """An oss2.Bucket stand-in that is good enough: after CopyObject, (optionally) "reveals" the target file on the mount point.

    `remote` specifies the bytes OSS really stores (by default identical to the source file on the mount), and `remote_mtime`
    specifies the object's Last-Modified (by default "now", i.e. already written back). `crc` / `etag` control which
    checksums the head carries: by default both are computed from the remote bytes; `etag="multipart"` simulates the `<md5>-<n>` form of multipart uploads.
    """

    bucket_name = "bkt"

    def __init__(
        self,
        *,
        materialize: bool = True,
        exists: bool = True,
        remote: bytes | None = None,
        remote_mtime: float | None = None,
        crc: bool = True,
        etag: bool | str = True,
    ):
        self.copies: list[tuple[str, str, str]] = []
        self.heads: list[str] = []
        self.materialize = materialize
        self.exists = exists
        self.remote = remote
        self.remote_mtime = remote_mtime
        self.crc = crc
        self.etag = etag

    @staticmethod
    def _local(key: str) -> Path:
        prefix = str(config.OSS_OBJECT_PREFIX).strip("/") + "/"
        return Path(config.OUTPUT_DIR) / key[len(prefix) :]

    def _remote_bytes(self, key: str) -> bytes:
        return self.remote if self.remote is not None else self._local(key).read_bytes()

    def head_object(self, key: str):
        self.heads.append(key)
        if not self.exists:
            raise RuntimeError("NoSuchKey")
        data = self._remote_bytes(key)
        crc = Crc64()
        crc.update(data)
        md5 = hashlib.md5(data, usedforsecurity=False).hexdigest().upper()
        if self.etag == "multipart":
            etag = f'"{md5}-3"'
        elif self.etag:
            etag = f'"{md5}"'
        else:
            etag = None
        return SimpleNamespace(
            content_length=len(data),
            last_modified=self.remote_mtime if self.remote_mtime is not None else time.time(),
            etag=etag,
            _server_crc=int(crc.crc) if self.crc else None,
            headers={},
        )

    def copy_object(self, source_bucket_name, source_key, target_key, headers=None, params=None):
        self.copies.append((source_bucket_name, source_key, target_key))
        if not self.materialize:
            return
        target = self._local(target_key)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(self._remote_bytes(source_key))


def _two_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    output_root = tmp_path / "output"
    monkeypatch.setattr(config, "OUTPUT_DIR", str(output_root))
    monkeypatch.setattr(config, "OSS_OBJECT_PREFIX", "output")
    source = output_root / "alice" / "demo" / "freezone" / "_uploads" / "a.png"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"png-bytes")
    target = output_root / "bob" / "vlog" / "freezone" / "_uploads" / "copied_a.png"
    return source, target


def test_copy_project_file_uses_filesystem_when_oss_is_unavailable(tmp_path, monkeypatch):
    source, target = _two_files(tmp_path, monkeypatch)
    monkeypatch.setattr(oss_client, "get_bucket", lambda: None)

    assert asset_copy.copy_project_file(source, target) == "filesystem"
    assert target.read_bytes() == b"png-bytes"


def test_copy_project_file_prefers_a_server_side_oss_copy(tmp_path, monkeypatch):
    source, target = _two_files(tmp_path, monkeypatch)
    bucket = _FakeBucket()
    monkeypatch.setattr(oss_client, "get_bucket", lambda: bucket)

    assert asset_copy.copy_project_file(source, target) == "oss"
    assert bucket.copies == [
        (
            "bkt",
            "output/alice/demo/freezone/_uploads/a.png",
            "output/bob/vlog/freezone/_uploads/copied_a.png",
        )
    ]
    assert target.read_bytes() == b"png-bytes"


def test_copy_project_file_falls_back_when_the_source_is_not_in_oss_yet(tmp_path, monkeypatch):
    """ossfs write-back is delayed: a just-uploaded source file may not have reached OSS yet, so CopyObject must not be used."""
    source, target = _two_files(tmp_path, monkeypatch)
    bucket = _FakeBucket(exists=False)
    monkeypatch.setattr(oss_client, "get_bucket", lambda: bucket)

    assert asset_copy.copy_project_file(source, target) == "filesystem"
    assert bucket.copies == []
    assert target.read_bytes() == b"png-bytes"


@pytest.mark.parametrize("mtime_offset", [-600, -1, 0, +5])
def test_copy_project_file_falls_back_when_the_oss_object_is_a_stale_same_size_version(
    tmp_path, monkeypatch, mtime_offset
):
    """The source file is overwritten in place and ossfs has not written back: OSS holds an old version of the same size. Looking only at "object exists +
    target size matches" would keep the old content in the target project permanently as a successful result; a Last-Modified that differs by a second or two
    or is even newer than the local one (clock skew) cannot be judged reliably either. The judgment goes by content checksum, independent of timestamps."""
    source, target = _two_files(tmp_path, monkeypatch)
    source.write_bytes(b"NEW!")
    bucket = _FakeBucket(remote=b"OLD!", remote_mtime=source.stat().st_mtime + mtime_offset)
    monkeypatch.setattr(oss_client, "get_bucket", lambda: bucket)

    assert asset_copy.copy_project_file(source, target) == "filesystem"
    assert bucket.copies == []
    assert target.read_bytes() == b"NEW!"


def test_copy_project_file_accepts_a_matching_single_part_etag_without_crc(tmp_path, monkeypatch):
    """Without a CRC header, compare the ETag instead: the ETag of a single-shot upload is the content MD5."""
    source, target = _two_files(tmp_path, monkeypatch)
    bucket = _FakeBucket(crc=False)
    monkeypatch.setattr(oss_client, "get_bucket", lambda: bucket)

    assert asset_copy.copy_project_file(source, target) == "oss"
    assert len(bucket.copies) == 1
    assert target.read_bytes() == b"png-bytes"


def test_copy_project_file_falls_back_when_only_a_multipart_etag_is_available(
    tmp_path, monkeypatch
):
    """The ETag of a multipart upload is not the content MD5, and with no CRC either -> the version cannot be confirmed, so fall back."""
    source, target = _two_files(tmp_path, monkeypatch)
    bucket = _FakeBucket(crc=False, etag="multipart")
    monkeypatch.setattr(oss_client, "get_bucket", lambda: bucket)

    assert asset_copy.copy_project_file(source, target) == "filesystem"
    assert bucket.copies == []
    assert target.read_bytes() == b"png-bytes"


def test_copy_project_file_falls_back_when_the_head_carries_no_checksum(tmp_path, monkeypatch):
    source, target = _two_files(tmp_path, monkeypatch)
    bucket = _FakeBucket(crc=False, etag=False)
    monkeypatch.setattr(oss_client, "get_bucket", lambda: bucket)

    assert asset_copy.copy_project_file(source, target) == "filesystem"
    assert bucket.copies == []


def test_copy_project_file_falls_back_when_the_oss_object_size_differs(tmp_path, monkeypatch):
    source, target = _two_files(tmp_path, monkeypatch)
    bucket = _FakeBucket(remote=b"png-bytes-but-longer")
    monkeypatch.setattr(oss_client, "get_bucket", lambda: bucket)

    assert asset_copy.copy_project_file(source, target) == "filesystem"
    assert bucket.copies == []
    assert target.read_bytes() == b"png-bytes"


def test_copy_project_file_falls_back_when_the_bucket_cannot_confirm_the_version(
    tmp_path, monkeypatch
):
    """If head cannot be obtained (old SDK / the stand-in does not implement it), treat it as uncertain: better to take one more filesystem copy."""
    source, target = _two_files(tmp_path, monkeypatch)

    class _NoHead:
        bucket_name = "bkt"
        copies: list = []

        def copy_object(self, *args, **kwargs):
            self.copies.append(args)

    bucket = _NoHead()
    monkeypatch.setattr(oss_client, "get_bucket", lambda: bucket)

    assert asset_copy.copy_project_file(source, target) == "filesystem"
    assert bucket.copies == []
    assert target.read_bytes() == b"png-bytes"


def test_copy_project_file_falls_back_when_the_copy_is_invisible_on_the_mount(
    tmp_path, monkeypatch
):
    """CopyObject succeeds but the target file is not visible on the mount point (negative cache, etc.) -> take the filesystem fallback, and do not return a URL that 404s."""
    source, target = _two_files(tmp_path, monkeypatch)
    bucket = _FakeBucket(materialize=False)
    monkeypatch.setattr(oss_client, "get_bucket", lambda: bucket)

    assert asset_copy.copy_project_file(source, target) == "filesystem"
    assert len(bucket.copies) == 1
    assert target.read_bytes() == b"png-bytes"


def test_copy_project_file_falls_back_when_oss_copy_raises(tmp_path, monkeypatch):
    source, target = _two_files(tmp_path, monkeypatch)

    class _Exploding(_FakeBucket):
        def copy_object(self, *args, **kwargs):
            raise RuntimeError("oss down")

    monkeypatch.setattr(oss_client, "get_bucket", lambda: _Exploding())

    assert asset_copy.copy_project_file(source, target) == "filesystem"
    assert target.read_bytes() == b"png-bytes"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

USER = {"id": "user_bob", "username": "bob"}


def _ctx(tmp_path: Path, project_id: str, *, owner: str, name: str, role: str) -> ProjectContext:
    return ProjectContext(
        project_id=project_id,
        project_name=name,
        owner_type="user",
        owner_id=f"user_{owner}",
        owner_username=owner,
        requester_user_id="user_bob",
        requester_username="bob",
        requester_principals=(("user", "user_bob"),),
        effective_role=role,
        home_node_id="node_a",
        output_dir=tmp_path / "output" / owner / name,
        state_dir=tmp_path / "state" / owner / name,
        runtime_dir=tmp_path / "runtime" / owner / name,
        is_home_node=True,
    )


def _patch_projects(monkeypatch: pytest.MonkeyPatch, ctxs: dict[str, ProjectContext]) -> None:
    """Stub only the control plane: the role check follows the real function, and the guard and disk write remain in the chain as is."""

    async def fake_resolve_project_context(
        *, user, project_id=None, project_name=None, required_role="viewer"
    ) -> ProjectContext:
        ctx = ctxs.get(project_id or "")
        if ctx is None:
            raise HTTPException(status_code=404, detail="Project not found")
        require_role_value(ctx.effective_role, required_role)
        return ctx

    monkeypatch.setattr(freezone_routes, "resolve_project_context", fake_resolve_project_context)


def _source_asset(ctx: ProjectContext, rel: str, payload: bytes) -> str:
    path = ctx.output_dir / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return f"/static/projects/{ctx.project_id}/{rel}"


async def test_copy_route_copies_source_assets_into_the_target_uploads_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(oss_client, "get_bucket", lambda: None)
    source_ctx = _ctx(tmp_path, "proj_src", owner="alice", name="rigeng", role="viewer")
    target_ctx = _ctx(tmp_path, "proj_dst", owner="bob", name="vlog", role="editor")
    target_ctx.output_dir.mkdir(parents=True)
    _patch_projects(monkeypatch, {"proj_src": source_ctx, "proj_dst": target_ctx})
    image = _source_asset(source_ctx, "freezone/_uploads/20260101_a.png", b"png-bytes")
    video = _source_asset(source_ctx, "freezone/_outputs/video/clip.mp4", b"mp4-bytes")

    result = await freezone_routes.freezone_copy_assets_from_project(
        project="proj_dst",
        body=FreezoneAssetCopyRequest(sources=[f"{image}?v=1", image, video]),
        user=USER,
    )

    assert result["ok"] is True
    data = result["data"]
    assert data["failed"] == []
    mapping = data["mapping"]
    # Both with and without a cache-bust query string must be mapped, and the same source file is copied only once.
    assert set(mapping) == {f"{image}?v=1", image, video}
    assert mapping[f"{image}?v=1"] == mapping[image]
    for new_url in mapping.values():
        assert new_url.startswith("/static/projects/proj_dst/freezone/_uploads/")

    uploads = sorted((target_ctx.output_dir / "freezone" / "_uploads").iterdir())
    assert [p.read_bytes() for p in uploads] == [b"png-bytes", b"mp4-bytes"]
    assert uploads[0].name.endswith("_20260101_a.png")
    assert uploads[1].name.endswith("_clip.mp4")


async def test_copy_route_reports_per_source_failures_without_failing_the_batch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(oss_client, "get_bucket", lambda: None)
    source_ctx = _ctx(tmp_path, "proj_src", owner="alice", name="rigeng", role="viewer")
    # The requester is not a member of this project: the role given by the control plane is empty.
    foreign_ctx = _ctx(tmp_path, "proj_foreign", owner="carol", name="private", role="")
    target_ctx = _ctx(tmp_path, "proj_dst", owner="bob", name="vlog", role="editor")
    target_ctx.output_dir.mkdir(parents=True)
    _patch_projects(
        monkeypatch,
        {"proj_src": source_ctx, "proj_foreign": foreign_ctx, "proj_dst": target_ctx},
    )
    good = _source_asset(source_ctx, "freezone/_uploads/good.png", b"ok")
    forbidden = _source_asset(foreign_ctx, "freezone/_uploads/secret.png", b"secret")
    missing = f"/static/projects/{source_ctx.project_id}/freezone/_uploads/missing.png"
    traversal = f"/static/projects/{source_ctx.project_id}/../../secret.txt"
    unknown_project = "/static/projects/proj_nope/freezone/_uploads/x.png"
    external = "https://cdn.example/x.png"
    already_here = "/static/projects/proj_dst/freezone/_uploads/mine.png"

    result = await freezone_routes.freezone_copy_assets_from_project(
        project="proj_dst",
        body=FreezoneAssetCopyRequest(
            sources=[good, forbidden, missing, traversal, unknown_project, external, already_here]
        ),
        user=USER,
    )

    data = result["data"]
    assert set(data["mapping"]) == {good}
    failed = {item["source"]: item["reason"] for item in data["failed"]}
    assert failed == {
        forbidden: "forbidden",
        missing: "not_found",
        traversal: "invalid_source",
        unknown_project: "not_found",
        external: "invalid_source",
    }
    # A URL that already belongs to the target project: no need to copy, and it does not count as a failure.
    assert already_here not in data["mapping"]
    assert already_here not in failed
    # A failed source must not leave a half-finished product in the target project: the directory holds only that one successfully copied file.
    uploads = list((target_ctx.output_dir / "freezone" / "_uploads").iterdir())
    assert [p.read_bytes() for p in uploads] == [b"ok"]


async def test_copy_route_isolates_preparation_failures_to_the_single_asset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The preparation phase (parsing the URL, locating the source file, naming the target) blowing up also counts as only that one failure.

    Previously `http://[` raised ValueError in urlsplit, `bad%00.png` raised ValueError at resolve, and a legal 234-byte file name with the timestamp prefix added made
    `exists()` raise OSError; each would terminate the whole batch before any copy began, so even good.png in the same batch could not be migrated.
    """
    monkeypatch.setattr(oss_client, "get_bucket", lambda: None)
    source_ctx = _ctx(tmp_path, "proj_src", owner="alice", name="rigeng", role="viewer")
    target_ctx = _ctx(tmp_path, "proj_dst", owner="bob", name="vlog", role="editor")
    target_ctx.output_dir.mkdir(parents=True)
    _patch_projects(monkeypatch, {"proj_src": source_ctx, "proj_dst": target_ctx})
    good = _source_asset(source_ctx, "freezone/_uploads/good.png", b"ok")
    long_name = "x" * 230 + ".png"
    assert len(long_name) == 234
    long_asset = _source_asset(source_ctx, f"freezone/_uploads/{long_name}", b"long")
    null_byte = f"/static/projects/{source_ctx.project_id}/freezone/_uploads/bad%00.png"
    malformed = "http://["  # urlsplit itself raises ValueError: Invalid IPv6 URL

    result = await freezone_routes.freezone_copy_assets_from_project(
        project="proj_dst",
        body=FreezoneAssetCopyRequest(sources=[malformed, null_byte, long_asset, good]),
        user=USER,
    )

    data = result["data"]
    assert set(data["mapping"]) == {good, long_asset}
    assert data["failed"] == [
        {"source": malformed, "reason": "invalid_source"},
        {"source": null_byte, "reason": "invalid_source"},
    ]
    uploads = {p.read_bytes(): p.name for p in (target_ctx.output_dir / "freezone" / "_uploads").iterdir()}
    assert set(uploads) == {b"ok", b"long"}
    assert len(uploads[b"long"].encode()) <= 255
    assert uploads[b"long"].endswith(".png")
    assert uploads[b"long"] in data["mapping"][long_asset]


async def test_copy_route_requires_editor_on_the_target_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_ctx = _ctx(tmp_path, "proj_src", owner="alice", name="rigeng", role="editor")
    target_ctx = _ctx(tmp_path, "proj_dst", owner="bob", name="vlog", role="viewer")
    _patch_projects(monkeypatch, {"proj_src": source_ctx, "proj_dst": target_ctx})
    asset = _source_asset(source_ctx, "freezone/_uploads/a.png", b"png")

    with pytest.raises(HTTPException) as excinfo:
        await freezone_routes.freezone_copy_assets_from_project(
            project="proj_dst",
            body=FreezoneAssetCopyRequest(sources=[asset]),
            user=USER,
        )
    assert excinfo.value.status_code == 403


def test_copy_request_caps_the_batch_size():
    FreezoneAssetCopyRequest(sources=["/static/projects/p/a.png"] * asset_copy.MAX_SOURCES_PER_REQUEST)
    with pytest.raises(ValidationError):
        FreezoneAssetCopyRequest(
            sources=["/static/projects/p/a.png"] * (asset_copy.MAX_SOURCES_PER_REQUEST + 1)
        )
    with pytest.raises(ValidationError):
        FreezoneAssetCopyRequest(sources=[])
