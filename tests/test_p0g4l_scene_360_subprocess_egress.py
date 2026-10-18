"""OI-57: the newapi call of the 360 panorama runs in a separate subprocess; the egress gate must be installed at the process-spawn point.

`scene_360_builder` has its own `__main__`; `stage_asset_tasks.run_scene_360` assembles argv and then starts a **separate OS process** via
`run_project_subprocess`. What `model_gateway_scope_for_runner` binds is a
ContextVar, which survives `asyncio.run` / `to_thread` but not `fork/exec` - so the OI-48
ambient fallback and the OI-52 call-site gate are both ineffective at this one place.

Shape of the fix (decided by the user on 2026-08-12): **identity does not cross the process boundary; only the resolved organization credential does**.
The parent process claims + resolves the organization credential (reusing OI-52's `_prepare_organization_image_egress` /
`_complete_organization_image_egress`) and hands it to the subprocess through a process-local env; the subprocess carries a mode flag and
fails closed, never falling back to the platform Key in settings.db; the trace comes back through the manifest to complete the claim.

The two OpenRouter-direct VLM side subprocesses (`scene_overlap_analyzer` /
`scene_spatial_contract`) have no corresponding gateway capability bit, so under an organization they take their existing skip branch.
"""

from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.egress_context import (
    TRUSTED_EGRESS_CONTEXT_KEY,
    TrustedEgressContext,
    TrustedRunnerEnvelope,
)
from novelvideo.model_gateway_runtime import model_gateway_request_scope
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.egress_operations import (
    OperationClaimResult,
    OperationSnapshot,
    OperationState,
)
from novelvideo.ports.model_credentials import CredentialReference, RequestCredential

GATEWAY_KEY = "request-scoped-360-key"
GATEWAY_BASE_URL = "https://gateway.invalid/v1"
PLATFORM_CANARY = "platform-canary-must-not-cross"


def _egress_context(
    *, kind: str, envelope_id: str | None = None
) -> TrustedEgressContext:
    organization = kind == "organization"
    return TrustedEgressContext(
        envelope_id=envelope_id or f"env-360-{kind}",
        project_id="project-360",
        task_type="scene_pano_generation",
        requester_user_id="user-360",
        root_task_id="root-360",
        admission_id="admission-360",
        admitted_at="2026-08-12T04:05:00Z",
        membership_id="membership-360" if organization else None,
        authz_version=3,
        billing_principal=BillingPrincipal(
            kind=kind,
            id="org-360" if organization else "user-360",
        ),
        credential=CredentialReference(
            source="organization" if organization else "platform",
            credential_id="credential-360" if organization else "platform-newapi",
            key_version=9 if organization else 1,
            org_id="org-360" if organization else None,
        ),
    )


class _CredentialPort:
    def __init__(self, credential: RequestCredential, events: list[str]) -> None:
        self.credential = credential
        self.admissions: list[object] = []
        self.events = events

    async def resolve(self, admission):
        self.events.append("resolve")
        self.admissions.append(admission)
        return self.credential


class _OperationPort:
    def __init__(self, events: list[str]) -> None:
        self.claims: list[object] = []
        self.states: dict[str, OperationSnapshot] = {}
        self.tokens: dict[str, str] = {}
        self.completed_refs: list[str] = []
        self.provider_job_ids: list[str] = []
        self.unknowns: list[str] = []
        self.rejected: list[str] = []
        self.events = events

    async def claim(self, *, spec):
        self.events.append("claim")
        self.claims.append(spec)
        existing = self.states.get(spec.operation_key)
        if existing is not None:
            return OperationClaimResult(won=False, operation=existing)
        snapshot = OperationSnapshot(
            operation_id=f"operation-{len(self.claims)}",
            operation_key=spec.operation_key,
            state=OperationState.DISPATCHING,
            version=1,
        )
        self.states[spec.operation_key] = snapshot
        token = f"transition-{len(self.claims)}"
        self.tokens[snapshot.operation_id] = token
        return OperationClaimResult(
            won=True, operation=snapshot, transition_token=token
        )

    def _current(self, operation_id: str) -> OperationSnapshot:
        return next(
            value
            for value in self.states.values()
            if value.operation_id == operation_id
        )

    async def mark_accepted(
        self, *, operation_id, transition_token, expected_version, provider_job_id
    ):
        assert transition_token == self.tokens[operation_id]
        assert provider_job_id
        self.provider_job_ids.append(provider_job_id)
        current = self._current(operation_id)
        accepted = OperationSnapshot(
            operation_id=operation_id,
            operation_key=current.operation_key,
            state=OperationState.ACCEPTED,
            version=current.version + 1,
        )
        self.states[current.operation_key] = accepted
        return accepted

    async def mark_completed(
        self, *, operation_id, transition_token, expected_version, result_ref
    ):
        assert transition_token == self.tokens[operation_id]
        assert result_ref
        self.completed_refs.append(result_ref)
        current = self._current(operation_id)
        completed = OperationSnapshot(
            operation_id=operation_id,
            operation_key=current.operation_key,
            state=OperationState.COMPLETED,
            version=current.version + 1,
        )
        self.states[current.operation_key] = completed
        return completed

    async def mark_unknown(self, *, operation_id, transition_token, expected_version):
        self.events.append("unknown")
        self.unknowns.append(operation_id)
        return None

    async def mark_rejected_before_submit(
        self, *, operation_id, transition_token, expected_version
    ):
        self.rejected.append(operation_id)
        return None


def _png_bytes() -> bytes:
    from PIL import Image

    buffer = BytesIO()
    Image.new("RGB", (16, 16), (10, 20, 30)).save(buffer, format="PNG")
    return buffer.getvalue()


def _child_module(cmd: list[str]) -> str:
    return cmd[2] if len(cmd) > 2 and cmd[1] == "-m" else ""


class _SceneHarness:
    """Install the fakes already verified in OI-52 at the spawn point of `run_scene_360`."""

    def __init__(
        self,
        monkeypatch: pytest.MonkeyPatch,
        context: TrustedEgressContext | None,
        *,
        returncode: int = 0,
        write_manifest: bool = True,
    ) -> None:
        import novelvideo.ports as ports
        from novelvideo import stage_asset_tasks

        self.module = stage_asset_tasks
        self.context = context
        self.events: list[str] = []
        self.launches: list[dict[str, object]] = []
        self.credential_port = _CredentialPort(
            RequestCredential(
                reference=(
                    context.credential
                    if context is not None
                    else CredentialReference(
                        source="platform",
                        credential_id="platform-newapi",
                        key_version=1,
                        org_id=None,
                    )
                ),
                api_key=GATEWAY_KEY,
                base_url=GATEWAY_BASE_URL,
            ),
            self.events,
        )
        self.operation_port = _OperationPort(self.events)
        monkeypatch.setattr(
            ports, "get_model_credentials", lambda: self.credential_port
        )
        monkeypatch.setattr(
            ports, "get_egress_operation_port", lambda: self.operation_port
        )

        launches = self.launches
        events = self.events

        def spy(cmd, **kwargs):
            module_name = _child_module(list(cmd))
            events.append(f"launch:{module_name.rsplit('.', 1)[-1]}")
            launches.append(
                {"cmd": list(cmd), "env": kwargs.get("env"), "module": module_name}
            )
            if module_name.endswith("scene_360_builder") and returncode == 0:
                out_dir = Path(cmd[cmd.index("--output-dir") + 1])
                out_dir.mkdir(parents=True, exist_ok=True)
                (out_dir / "scene_panorama_2to1.png").write_bytes(_png_bytes())
                if write_manifest:
                    (out_dir / "scene_360_manifest.json").write_text(
                        json.dumps(
                            {
                                "request_id": "gateway-request-360",
                                "response_id": "gateway-response-360",
                            }
                        ),
                        encoding="utf-8",
                    )
            return SimpleNamespace(
                returncode=returncode, stdout="", stderr="child failed"
            )

        monkeypatch.setattr(stage_asset_tasks, "run_project_subprocess", spy)

    def modules_launched(self) -> list[str]:
        return [str(entry["module"]).rsplit(".", 1)[-1] for entry in self.launches]

    def pano_launch(self) -> dict[str, object]:
        return next(
            entry
            for entry in self.launches
            if str(entry["module"]).endswith("scene_360_builder")
        )


def _run_pano(tmp_path: Path, **kwargs):
    from novelvideo import stage_asset_tasks

    kwargs.setdefault("provider", "newapi")
    kwargs.setdefault("source", "text")
    return stage_asset_tasks.run_scene_360(
        tmp_path / "project",
        "scene-360",
        artifact_dir=tmp_path / "stage",
        update_manifest=False,
        _manage_model_credit=False,
        **kwargs,
    )


# --- Organization path: claim before spawning the process, credential crosses the boundary via env --------


def test_organization_pano_claims_and_injects_gateway_credential_before_launch(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Claim + credential resolution must happen before spawning the subprocess, and the credential is handed to the subprocess via env."""

    context = _egress_context(kind="organization")
    harness = _SceneHarness(monkeypatch, context)

    with model_gateway_request_scope(context):
        _run_pano(tmp_path)

    assert harness.events[:3] == ["claim", "resolve", "launch:scene_360_builder"]

    claim = harness.operation_port.claims[0]
    assert len(harness.operation_port.claims) == 1
    assert claim.capability == "image.generate.pano_360"
    assert claim.organization_id == "org-360"
    assert claim.credential_version == 9

    env = harness.pano_launch()["env"]
    assert env is not None, "the organization path must pass a curated env and must not let the subprocess inherit the parent environ"
    assert env["ST_ORG_EGRESS_MODE"] == "1"
    assert env["ST_ORG_GATEWAY_API_KEY"] == GATEWAY_KEY
    assert env["ST_ORG_GATEWAY_BASE_URL"] == GATEWAY_BASE_URL


def test_platform_key_canary_never_reaches_the_child_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The subprocess env must be a curated copy with platform secrets removed.

    Today `run_project_subprocess` passes `env=None`, so the subprocess inherits the parent's whole environ;
    without removing the platform Key, the subprocess-side fail-closed is only on paper - it can still resolve the platform Key.
    """

    for name in (
        "NEWAPI_API_KEY",
        "NEWAPI_BASE_URL",
        "MODEL_API_KEY",
        "MODEL_BASE_URL",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
    ):
        monkeypatch.setenv(name, PLATFORM_CANARY)

    context = _egress_context(kind="organization")
    harness = _SceneHarness(monkeypatch, context)

    with model_gateway_request_scope(context):
        _run_pano(tmp_path)

    env = harness.pano_launch()["env"]
    assert PLATFORM_CANARY not in env.values()
    for name in (
        "NEWAPI_API_KEY",
        "NEWAPI_BASE_URL",
        "MODEL_API_KEY",
        "MODEL_BASE_URL",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
    ):
        assert name not in env


def test_organization_non_newapi_provider_denies_before_any_launch(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Organization + non-newapi provider must be rejected before spawning the process: zero subprocesses, zero artifacts."""

    context = _egress_context(kind="organization")
    harness = _SceneHarness(monkeypatch, context)

    with model_gateway_request_scope(context):
        with pytest.raises(Exception) as denied:
            _run_pano(tmp_path, provider="google")

    assert getattr(denied.value, "code", None) == "ORG_EGRESS_DENIED"
    assert harness.launches == []
    generated = tmp_path / "stage" / "scene_360_generation" / "scene_panorama_2to1.png"
    assert not generated.exists()


def test_organization_completion_records_trace_and_result_ref(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The request_id the subprocess writes into the manifest must return to the claim to complete the ledger."""

    context = _egress_context(kind="organization")
    harness = _SceneHarness(monkeypatch, context)

    with model_gateway_request_scope(context):
        _run_pano(tmp_path)

    assert harness.operation_port.provider_job_ids == ["gateway-request-360"]
    assert len(harness.operation_port.completed_refs) == 1
    assert harness.operation_port.completed_refs[0].startswith("image:sha256:")
    assert harness.operation_port.unknowns == []


def test_child_failure_marks_the_operation_unknown(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """When the subprocess exits non-zero we cannot prove the request was not sent, so the claim must land on unknown rather than dangling."""

    context = _egress_context(kind="organization")
    harness = _SceneHarness(monkeypatch, context, returncode=1)

    with model_gateway_request_scope(context):
        with pytest.raises(RuntimeError):
            _run_pano(tmp_path)

    assert len(harness.operation_port.claims) == 1
    assert len(harness.operation_port.unknowns) == 1
    assert harness.operation_port.completed_refs == []


def test_platform_pano_launches_without_any_organization_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Platform/personal path is byte-for-byte unchanged: no claim, no env passed, the subprocess inherits environ as before."""

    harness = _SceneHarness(monkeypatch, None)

    _run_pano(tmp_path)

    assert harness.operation_port.claims == []
    assert harness.pano_launch()["env"] is None


# --- Two OpenRouter side subprocesses: under an organization they take the existing skip branch --------


def _master_pair(tmp_path: Path) -> dict[str, Path]:
    scene_dir = tmp_path / "masters"
    scene_dir.mkdir(parents=True, exist_ok=True)
    master = scene_dir / "master.png"
    reverse = scene_dir / "reverse.png"
    master.write_bytes(_png_bytes())
    reverse.write_bytes(_png_bytes())
    return {"master": master, "reverse": reverse}


def test_organization_skips_the_openrouter_vlm_children(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Under an organization, even if OPENROUTER_API_KEY is present, the two VLM side subprocesses must not start.

    They are OpenRouter-direct with no corresponding gateway capability bit; on the platform they only run when a Key is configured
    and silently skip when not, so organizations reuse this well-worn branch and the 360 main flow still produces images as usual."""
    """

    monkeypatch.setenv("OPENROUTER_API_KEY", "openrouter-present")
    pair = _master_pair(tmp_path)
    context = _egress_context(kind="organization")
    harness = _SceneHarness(monkeypatch, context)

    with model_gateway_request_scope(context):
        _run_pano(
            tmp_path,
            source="master",
            master_path_override=pair["master"],
            reverse_master_path_override=pair["reverse"],
        )

    assert harness.modules_launched() == ["scene_360_builder"]


def test_platform_still_launches_the_openrouter_vlm_children(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The skip applies only to organizations - with a platform Key the two side processes start as before."""

    monkeypatch.setenv("OPENROUTER_API_KEY", "openrouter-present")
    pair = _master_pair(tmp_path)
    harness = _SceneHarness(monkeypatch, None)

    _run_pano(
        tmp_path,
        source="master",
        master_path_override=pair["master"],
        reverse_master_path_override=pair["reverse"],
    )

    launched = harness.modules_launched()
    assert "scene_overlap_analyzer" in launched
    assert "scene_spatial_contract" in launched
    assert "scene_360_builder" in launched


# --- Subprocess side: fail-closed, never fall back to the platform Key --------------------


def test_child_fails_closed_when_org_mode_lacks_a_credential(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With the mode flag but no credential received it must raise an error, and not fall back to the platform Key in settings.db.

    "No credential received" and "this is a platform task" must be distinguishable - the presence of the credential itself cannot serve as the flag,
    otherwise it is the OI-48 "parameter present but not picked up" replayed in another place."""
    """

    from novelvideo.director_world import scene_360_builder

    monkeypatch.setenv("ST_ORG_EGRESS_MODE", "1")
    monkeypatch.delenv("ST_ORG_GATEWAY_API_KEY", raising=False)
    monkeypatch.delenv("ST_ORG_GATEWAY_BASE_URL", raising=False)

    def platform_fallback(**_kwargs):
        raise AssertionError("org mode must never fall back to platform credentials")

    monkeypatch.setattr(
        "novelvideo.config.get_newapi_runtime_credentials", platform_fallback
    )

    with pytest.raises(Exception) as failed:
        scene_360_builder._resolve_newapi_credentials()

    assert "ORG_CONTEXT_REQUIRED" in str(failed.value) or (
        getattr(failed.value, "code", None) == "ORG_CONTEXT_REQUIRED"
    )


def test_child_passes_the_injected_credential_as_an_explicit_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """It must go through `api_key_override=`, not rely on env-name fallback.

    The env fallback of `get_newapi_runtime_credentials` only takes effect when `gateway.source == "environment"`
    (true for EE; CE reads settings.db). Stuffing `NEWAPI_API_KEY` is simply never read under CE,
    and the subprocess silently falls back to the platform Key - the egress is still sent, credits are still deducted, the platform still foots the bill.
    """

    from novelvideo.director_world import scene_360_builder

    monkeypatch.setenv("ST_ORG_EGRESS_MODE", "1")
    monkeypatch.setenv("ST_ORG_GATEWAY_API_KEY", GATEWAY_KEY)
    monkeypatch.setenv("ST_ORG_GATEWAY_BASE_URL", GATEWAY_BASE_URL)

    seen: list[dict[str, object]] = []

    def spy(**kwargs):
        seen.append(kwargs)
        return kwargs["api_key_override"], kwargs["base_url_override"]

    monkeypatch.setattr("novelvideo.config.get_newapi_runtime_credentials", spy)

    api_key, base_url = scene_360_builder._resolve_newapi_credentials()

    assert seen == [
        {"api_key_override": GATEWAY_KEY, "base_url_override": GATEWAY_BASE_URL}
    ]
    assert (api_key, base_url) == (GATEWAY_KEY, GATEWAY_BASE_URL)


def test_child_without_org_mode_keeps_the_platform_resolution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without the mode flag the subprocess behavior is byte-for-byte unchanged."""

    from novelvideo.director_world import scene_360_builder

    monkeypatch.delenv("ST_ORG_EGRESS_MODE", raising=False)

    seen: list[dict[str, object]] = []

    def spy(**kwargs):
        seen.append(kwargs)
        return "platform-key", "https://platform.invalid/v1"

    monkeypatch.setattr("novelvideo.config.get_newapi_runtime_credentials", spy)

    assert scene_360_builder._resolve_newapi_credentials() == (
        "platform-key",
        "https://platform.invalid/v1",
    )
    assert seen == [{}]


# --- Parameter threading: adding a parameter without wiring the argument is a fake guard (M6-P32) ---------


class _FakeTaskManager:
    def update_progress_for_project(self, *_args, **_kwargs) -> None:
        return None


def _ctx(tmp_path: Path):
    return SimpleNamespace(project_id="project-360", output_dir=tmp_path)


def _quiet_runner(monkeypatch: pytest.MonkeyPatch):
    from novelvideo.task_backend.runners import stage_asset as runner_module

    monkeypatch.setattr(runner_module, "get_task_manager", lambda: _FakeTaskManager())
    monkeypatch.setattr(
        runner_module,
        "raise_if_envelope_cancel_requested",
        lambda *_args, **_kwargs: None,
    )
    return runner_module


def _envelope(payload: dict[str, object], context: TrustedEgressContext):
    return TrustedRunnerEnvelope(
        {
            "__run_task_id": "task-360",
            "project_id": "project-360",
            "scope": "scene-360",
            "payload": payload,
            TRUSTED_EGRESS_CONTEXT_KEY: context,
        }
    )


@pytest.mark.parametrize(
    "step,target",
    [
        ("pano_from_master", "run_scene_360"),
        ("pano_from_text", "run_scene_360"),
        ("voxel_world_from_360", "run_voxel_world_from_360"),
    ],
)
def test_stage_asset_runner_passes_envelope_context_through(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, step: str, target: str
) -> None:
    """The three call sites of `run_stage_asset` must really hand the identity in the envelope to the executing function."""

    from novelvideo import stage_asset_tasks

    runner_module = _quiet_runner(monkeypatch)
    context = _egress_context(kind="organization")
    seen: list[object] = []

    def spy(*_args, **kwargs):
        seen.append(kwargs.get("egress_context"))
        return {"ok": True, "scene_id": "scene-360"}

    monkeypatch.setattr(stage_asset_tasks, target, spy)

    runner_module.run_stage_asset(
        _envelope(
            {
                "scene_name": "scene-360",
                "step": step,
                "params": {},
                "project_dir": str(tmp_path),
            },
            context,
        ),
        _ctx(tmp_path),
    )

    assert seen == [context]


def test_stage_asset_runner_passes_signed_catalog_model_authority(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from novelvideo import stage_asset_tasks

    runner_module = _quiet_runner(monkeypatch)
    context = _egress_context(kind="organization")
    seen: list[object] = []

    def spy(*_args, **kwargs):
        seen.append(kwargs.get("model_authority"))
        return {"ok": True, "scene_id": "scene-360"}

    monkeypatch.setattr(stage_asset_tasks, "run_scene_360", spy)

    runner_module.run_stage_asset(
        _envelope(
            {
                "scene_name": "scene-360",
                "step": "pano_from_text",
                "params": {
                    "provider": "newapi",
                    "model": "organization-authorized-pano-model",
                },
                "scene_360_model_authority": {
                    "kind": "catalog",
                    "catalog_id": "catalog-pano",
                    "provider": "newapi",
                    "model": "organization-authorized-pano-model",
                },
                "project_dir": str(tmp_path),
            },
            context,
        ),
        _ctx(tmp_path),
    )

    assert len(seen) == 1
    authority = seen[0]
    assert authority is not None
    assert (
        authority.catalog_id,
        authority.provider,
        authority.model,
    ) == (
        "catalog-pano",
        "newapi",
        "organization-authorized-pano-model",
    )


def test_stage_asset_runner_rejects_catalog_authority_from_plain_envelope(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from novelvideo import stage_asset_tasks
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope

    runner_module = _quiet_runner(monkeypatch)
    monkeypatch.setattr(
        stage_asset_tasks,
        "run_scene_360",
        lambda *_args, **_kwargs: {"ok": True, "scene_id": "scene-360"},
    )
    payload = {
        "scene_name": "scene-360",
        "step": "pano_from_text",
        "params": {
            "provider": "newapi",
            "model": "attacker-controlled-model",
        },
        "scene_360_model_authority": {
            "kind": "catalog",
            "catalog_id": "forged-catalog",
            "provider": "newapi",
            "model": "attacker-controlled-model",
        },
        "project_dir": str(tmp_path),
    }

    with pytest.raises(InvalidTaskEnvelope):
        runner_module.run_stage_asset(
            {"scope": "scene-360", "payload": payload},
            _ctx(tmp_path),
        )


@pytest.mark.parametrize(
    ("authority_provider", "authority_model"),
    [
        ("openai", "organization-authorized-pano-model"),
        ("newapi", "different-authorized-pano-model"),
    ],
)
def test_stage_asset_runner_rejects_catalog_authority_execution_mismatch(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    authority_provider: str,
    authority_model: str,
) -> None:
    from novelvideo import stage_asset_tasks
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope

    runner_module = _quiet_runner(monkeypatch)
    context = _egress_context(kind="organization")
    monkeypatch.setattr(
        stage_asset_tasks,
        "run_scene_360",
        lambda *_args, **_kwargs: {"ok": True, "scene_id": "scene-360"},
    )

    with pytest.raises(InvalidTaskEnvelope):
        runner_module.run_stage_asset(
            _envelope(
                {
                    "scene_name": "scene-360",
                    "step": "pano_from_text",
                    "params": {
                        "provider": "newapi",
                        "model": "organization-authorized-pano-model",
                    },
                    "scene_360_model_authority": {
                        "kind": "catalog",
                        "catalog_id": "catalog-pano",
                        "provider": authority_provider,
                        "model": authority_model,
                    },
                    "project_dir": str(tmp_path),
                },
                context,
            ),
            _ctx(tmp_path),
        )


def test_scene_pano_generation_runner_passes_envelope_context_through(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The billing entry `scene_pano_generation` must be wired through as well - it is the one that really deducts credits for organizations."""

    from novelvideo import stage_asset_tasks

    runner_module = _quiet_runner(monkeypatch)
    context = _egress_context(kind="organization")
    seen: list[object] = []

    def spy(*_args, **kwargs):
        seen.append(kwargs.get("egress_context"))
        return {"ok": True, "scene_id": "scene-360"}

    monkeypatch.setattr(stage_asset_tasks, "run_scene_360_feature_billed", spy)

    runner_module.run_scene_pano_generation(
        _envelope(
            {
                "scene_name": "scene-360",
                "step": "pano_from_text",
                "params": {},
                "project_dir": str(tmp_path),
            },
            context,
        ),
        _ctx(tmp_path),
    )

    assert seen == [context]


def _project_context(tmp_path: Path):
    from novelvideo.project_context import ProjectContext

    project_dir = tmp_path / "project"
    project_dir.mkdir(parents=True, exist_ok=True)
    return ProjectContext(project_id="project-360", project_dir=project_dir)
