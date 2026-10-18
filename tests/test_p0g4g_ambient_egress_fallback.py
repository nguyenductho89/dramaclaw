"""OI-48: a leaf gate must fall back to the request-scoped identity when a call site forgets to pass `egress_context=`.

Egress gates carry identity through an optional parameter, so "platform task, allowed" and "the call site forgot to pass the parameter"
collapse into the same `None` - the gate cannot tell them apart, so organization traffic connects upstream directly with platform credentials and is billed to the platform
account. The dispatch point (`task_backend/run_core.py`) already binds the identity to the request scope, and every **leaf** gate that makes an
`is_organization` verdict must be able to read it.

Pass-through sites (`egress_context=egress_context`) are excluded: as long as the leaf falls back, passing an empty value through
still yields the correct verdict, and resolving again at the pass-through site would only be duplication.
"""

from __future__ import annotations

import pytest

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.model_gateway_runtime import model_gateway_request_scope
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference


def _platform_context() -> TrustedEgressContext:
    return TrustedEgressContext(
        envelope_id="envelope-platform",
        project_id="project-1",
        task_type="sketch_generation",
        requester_user_id="user-1",
        root_task_id="root-platform",
        admission_id="admission-platform",
        admitted_at="2026-08-11T00:00:00Z",
        membership_id=None,
        authz_version=1,
        billing_principal=BillingPrincipal(kind="platform", id="user-1"),
        credential=CredentialReference(
            source="platform",
            credential_id="platform-newapi",
            key_version=1,
        ),
    )


def _organization_context() -> TrustedEgressContext:
    return TrustedEgressContext(
        envelope_id="envelope-1",
        project_id="project-1",
        task_type="sketch_generation",
        requester_user_id="user-1",
        root_task_id="root-task-1",
        admission_id="admission-1",
        admitted_at="2026-08-11T00:00:00Z",
        membership_id="membership-1",
        authz_version=7,
        billing_principal=BillingPrincipal(kind="organization", id="org-1"),
        credential=CredentialReference(
            source="organization",
            credential_id="credential-1",
            key_version=3,
            org_id="org-1",
        ),
    )


def test_platform_scope_is_not_adopted_as_an_egress_context() -> None:
    """The fallback only fills in the organization branch - a platform identity is synonymous with `None` in these gates.

    Otherwise fixing fail-open would cause a fail-closed false positive: `IndexTTS2FalClient.generate`
    returns `ORG_EGRESS_DENIED` directly for "has an identity and is not an organization"; falling the platform identity back into it
    would have the platform's own speech synthesis rejected by its own organization gate.
    """

    from novelvideo.egress_context import (
        ambient_egress_context,
        ambient_organization_egress_context,
    )
    from novelvideo.generators.indextts2_fal import IndexTTS2FalClient

    with model_gateway_request_scope(_platform_context()):
        assert ambient_egress_context() is not None
        assert ambient_organization_egress_context() is None
        client = IndexTTS2FalClient()
    assert client.egress_context is None


def test_subprocess_model_child_denies_org_without_explicit_context() -> None:
    """A forgotten parameter must not let an organization obtain a model subprocess holding platform secrets."""

    from novelvideo.task_backend.subprocesses import (
        EgressBoundaryError,
        build_model_child_env,
    )

    with model_gateway_request_scope(_organization_context()):
        with pytest.raises(EgressBoundaryError) as excinfo:
            build_model_child_env({"PATH": "/usr/bin"}, egress_context=None)
    assert excinfo.value.code == "ORG_EGRESS_DENIED"


def test_subprocess_launch_does_not_adopt_scope_identity() -> None:
    """A restricted launch does **not** fall back - it wants a policy prepared by the caller, not an identity verdict.

    Of the 16 `run_project_subprocess` call sites in the whole repo only one passes `restricted_policy`,
    and falling back would make all 15 other local ffmpeg/media commands be rejected for organizations. Those commands carry no credentials and
    make no egress, so rejecting them is functional breakage rather than a security gain.
    """

    from novelvideo.task_backend import subprocesses

    with model_gateway_request_scope(_organization_context()):
        proc = subprocesses.run_project_subprocess(
            ["/bin/echo", "hi"],
            capture_output=True,
            text=True,
        )
    assert proc.returncode == 0


@pytest.mark.asyncio
async def test_image_egress_denies_non_newapi_without_explicit_context() -> None:
    """Organizations may only go through newapi; a forgotten parameter must not silently let a direct fal connection through."""

    from novelvideo.generators.nanobanana_grid import (
        _prepare_organization_image_egress,
    )
    from novelvideo.ports.egress import EgressError

    with model_gateway_request_scope(_organization_context()):
        with pytest.raises(EgressError) as excinfo:
            await _prepare_organization_image_egress(
                egress_context=None,
                provider="fal",
                capability="image.asset.character",
                request={"model": "m"},
            )
    assert excinfo.value.code == "ORG_EGRESS_DENIED"


def test_character_generator_uses_request_scoped_credentials_by_default() -> None:
    """When no identity is passed at construction time, an organization must not get the platform provider and secrets from local config."""

    from novelvideo.generators.nanobanana_character import (
        NanoBananaCharacterGenerator,
    )

    with model_gateway_request_scope(_organization_context()):
        generator = NanoBananaCharacterGenerator()
    assert generator.provider == "newapi"
    assert generator.api_key == "request-scoped"


def test_indextts2_client_blanks_platform_key_without_explicit_context() -> None:
    """A forgotten parameter must not let an organization's speech synthesis land on platform FAL/newapi secrets."""

    from novelvideo.generators.indextts2_fal import IndexTTS2FalClient

    with model_gateway_request_scope(_organization_context()):
        client = IndexTTS2FalClient()
    assert client.api_key == ""
    assert client.endpoint == ""


@pytest.mark.asyncio
async def test_volcengine_image_generate_denies_org_without_explicit_context() -> None:
    """Volcano direct is a leaf organizations are forbidden to reach; a forgotten parameter must not bypass it."""

    from novelvideo.generators.image_generator import VolcengineImageGenerator
    from novelvideo.ports.egress import EgressError

    generator = VolcengineImageGenerator.__new__(VolcengineImageGenerator)
    with model_gateway_request_scope(_organization_context()):
        with pytest.raises(EgressError) as excinfo:
            await generator.generate(prompt="p", egress_context=None)
    assert excinfo.value.code == "ORG_EGRESS_DENIED"


def test_scope_survives_asyncio_run_into_a_leaf_gate() -> None:
    """`verification/sketch_edit_execute.py:546` enters the leaf via `asyncio.run` with no
    `egress_context` parameter to pass - it can only rely on the scoped identity. The ContextVar is copied into the new
    event loop by `asyncio.run`; this dependency must be pinned rather than assumed.
    """

    import asyncio

    from novelvideo.egress_context import ambient_organization_egress_context

    async def _inside() -> object:
        return ambient_organization_egress_context()

    with model_gateway_request_scope(_organization_context()):
        seen = asyncio.run(_inside())
    assert type(seen) is TrustedEgressContext


def test_seedream_is_a_legacy_alias_for_a_newapi_selection() -> None:
    """Pin down a refutation: the seedream rejection at `image_generator.py:1191` is not a hole.

    That check is evaluated **before** `normalize_character_image_selection`, so passing
    `model=None` seems to bypass it. But normalization never returns `"seedream"` - it is a historical alias mapped to
    `newapi_gpt_image2`, and newapi is exactly the channel organizations are **allowed** to use.
    Moving the check after normalization would only reject legitimate organization paths.
    """

    from novelvideo.config import normalize_character_image_selection

    assert normalize_character_image_selection("seedream") == "newapi_gpt_image2"
    assert normalize_character_image_selection(None).startswith("newapi_")


@pytest.mark.asyncio
async def test_prop_reference_uses_request_scoped_config_without_explicit_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When a prop turnaround omits the parameter it goes through the local provider config - it must fall back to the organization channel."""

    from novelvideo.generators import nanobanana_prop

    seen: dict[str, object] = {}

    async def _fake_text_to_image(**kwargs: object) -> None:
        seen.update(kwargs)

    monkeypatch.setattr(nanobanana_prop, "generate_text_to_image", _fake_text_to_image)
    with model_gateway_request_scope(_organization_context()):
        await nanobanana_prop.generate_prop_reference(
            visual_prompt="a sword",
            output_path="/tmp/oi48-prop.png",
        )
    assert seen.get("config", {}).get("provider") == "newapi"
    assert type(seen.get("egress_context")) is TrustedEgressContext


@pytest.mark.asyncio
async def test_freezone_gen_denies_volcengine_without_explicit_context(
    tmp_path,
) -> None:
    """When free-zone generation omits the parameter, an organization must still not be sent to Volcano direct."""

    from novelvideo.freezone import jobs
    from novelvideo.ports.egress import EgressError

    with model_gateway_request_scope(_organization_context()):
        with pytest.raises(EgressError) as excinfo:
            await jobs.run_freezone_gen(
                project_dir=tmp_path,
                job_id="job-1",
                prompt="p",
                provider="volcengine",
            )
    assert excinfo.value.code == "ORG_EGRESS_DENIED"


@pytest.mark.asyncio
async def test_beat_audio_builds_org_client_without_explicit_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When a whole voice batch omits the parameter it would use the platform client - it must fall back to the newapi organization client."""

    from novelvideo.audio import indextts2_beat_audio_task as task
    from novelvideo.generators import indextts2_fal

    seen: dict[str, object] = {}

    class _FakeClient:
        def __init__(self, **kwargs: object) -> None:
            seen.update(kwargs)

    class _StopHere(RuntimeError):
        pass

    class _Store:
        async def get_beats_as_dicts(self, episode: int) -> list[dict[str, object]]:
            raise _StopHere()

    monkeypatch.setattr(indextts2_fal, "IndexTTS2FalClient", _FakeClient)
    with model_gateway_request_scope(_organization_context()):
        with pytest.raises(_StopHere):
            await task.run_indextts2_beat_audio_generation(
                store=_Store(),
                username="user-1",
                project="project-1",
                episode=1,
                beat_numbers=[1],
            )
    assert seen.get("provider") == "newapi"
    assert type(seen.get("egress_context")) is TrustedEgressContext


@pytest.mark.asyncio
async def test_freezone_vision_egress_prepares_org_path_without_explicit_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When free-zone vision analysis omits the parameter it would be treated as platform traffic going direct - it must fall back to the organization channel."""

    from novelvideo.freezone import presets

    seen: dict[str, object] = {}

    async def _fake_prepare(**kwargs: object):
        seen.update(kwargs)
        return None

    monkeypatch.setattr(
        "novelvideo.generators.nanobanana_grid._prepare_organization_image_egress",
        _fake_prepare,
    )
    with model_gateway_request_scope(_organization_context()):
        await presets.prepare_freezone_vision_egress(
            egress_context=None,
            model_name="m",
            prompt="p",
            images=[],
            timeout_seconds=1.0,
        )
    assert type(seen.get("egress_context")) is TrustedEgressContext
