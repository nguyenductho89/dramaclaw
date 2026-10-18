"""OI-52: the 6 newapi image call sites of the grid family must go through the egress gate.

Six of the call sites of `_call_newapi_image_api` in `nanobanana_grid.py` neither pass `trace=`
nor `egress_context=`, nor go through any gate -- organization traffic on these paths has no claim, no organization
credential resolution, and no replay protection, so the platform Key fronts real compute for the organization.

The only correct call site is inside `_generate_image`; its shape (`_prepare_organization_image_egress`
-> swap credentials -> call the leaf -> `_complete_organization_image_egress`) is already pinned by
`tests/test_p0g4b_image_egress.py`. This file pins the same shape onto the 6 entry points of the grid family.

Of these 6 entry points only `generate_grid` / `reformat_sketch` currently have live callers; the other 4 have none
-- they still need assertions, otherwise they would silently leak again when revived.
"""

from __future__ import annotations

import base64

import pytest

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.model_gateway_runtime import model_gateway_request_scope
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.egress_operations import (
    OperationClaimResult,
    OperationSnapshot,
    OperationState,
)
from novelvideo.ports.model_credentials import CredentialReference, RequestCredential


def _egress_context(*, kind: str, envelope_id: str | None = None) -> TrustedEgressContext:
    organization = kind == "organization"
    return TrustedEgressContext(
        envelope_id=envelope_id or f"env-grid-{kind}",
        project_id="project-grid",
        task_type="grid_generation",
        requester_user_id="user-grid",
        root_task_id="root-grid",
        admission_id="admission-grid",
        admitted_at="2026-08-12T04:05:00Z",
        membership_id="membership-grid" if organization else None,
        authz_version=3,
        billing_principal=BillingPrincipal(
            kind=kind,
            id="org-grid" if organization else "user-grid",
        ),
        credential=CredentialReference(
            source="organization" if organization else "platform",
            credential_id="credential-grid" if organization else "platform-newapi",
            key_version=7 if organization else 1,
            org_id="org-grid" if organization else None,
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
        self.unknowns: list[str] = []
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
        return OperationClaimResult(won=True, operation=snapshot, transition_token=token)

    def _current(self, operation_id: str) -> OperationSnapshot:
        return next(
            value for value in self.states.values() if value.operation_id == operation_id
        )

    async def mark_accepted(
        self, *, operation_id, transition_token, expected_version, provider_job_id
    ):
        assert transition_token == self.tokens[operation_id]
        assert expected_version == 1
        assert provider_job_id
        current = self._current(operation_id)
        accepted = OperationSnapshot(
            operation_id=operation_id,
            operation_key=current.operation_key,
            state=OperationState.ACCEPTED,
            version=2,
        )
        self.states[current.operation_key] = accepted
        return accepted

    async def mark_completed(
        self, *, operation_id, transition_token, expected_version, result_ref
    ):
        assert transition_token == self.tokens[operation_id]
        assert expected_version == 2
        assert result_ref
        self.completed_refs.append(result_ref)
        current = self._current(operation_id)
        completed = OperationSnapshot(
            operation_id=operation_id,
            operation_key=current.operation_key,
            state=OperationState.COMPLETED,
            version=3,
        )
        self.states[current.operation_key] = completed
        return completed

    async def mark_unknown(self, *, operation_id, transition_token, expected_version):
        self.unknowns.append(operation_id)
        return None

    async def mark_rejected_before_submit(
        self, *, operation_id, transition_token, expected_version
    ):
        return None


def _grid_config() -> dict:
    return {
        "provider": "newapi",
        "api_key": "poison-config-key",
        "base_url": "https://poison.invalid/v1",
        "model": "frozen-grid-model",
        "mode": "1x1",
        "rows": 1,
        "cols": 1,
        "batch_size": 1,
        "total_panels": 1,
        "image_size": "1K",
    }


def _png_bytes() -> bytes:
    from io import BytesIO

    from PIL import Image

    buffer = BytesIO()
    Image.new("RGB", (16, 16), (10, 20, 30)).save(buffer, format="PNG")
    return buffer.getvalue()


class _Harness:
    """Install the fakes verified in test_p0g4b_image_egress.py onto the grid family entry points."""

    def __init__(self, monkeypatch, context: TrustedEgressContext) -> None:
        import httpx
        import novelvideo.ports as ports
        from novelvideo.generators import nanobanana_grid

        self.module = nanobanana_grid
        self.context = context
        self.events: list[str] = []
        self.posts: list[dict[str, object]] = []
        self.credential_port = _CredentialPort(
            RequestCredential(
                reference=context.credential,
                api_key="request-scoped-grid-key",
                base_url="https://gateway.invalid/v1",
            ),
            self.events,
        )
        self.operation_port = _OperationPort(self.events)
        monkeypatch.setattr(ports, "get_model_credentials", lambda: self.credential_port)
        monkeypatch.setattr(
            ports, "get_egress_operation_port", lambda: self.operation_port
        )

        posts = self.posts
        image_payload = base64.b64encode(_png_bytes()).decode()

        class FakeResponse:
            headers = {"x-newapi-request-id": "request-grid"}

            def raise_for_status(self):
                return None

            def json(self):
                return {
                    "id": "response-grid",
                    "data": [{"b64_json": image_payload}],
                }

        class FakeAsyncClient:
            def __init__(self, *_args, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def post(self, url, *, headers, json):
                posts.append({"url": url, "headers": headers, "json": json})
                return FakeResponse()

        monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

        async def fake_relay(_references, **_kwargs):
            return ["https://relay.invalid/reference.png"]

        monkeypatch.setattr(
            nanobanana_grid, "_relay_reference_images_for_newapi", fake_relay
        )

        for name in (
            "_call_openrouter_image_api",
            "_call_openai_image_api",
            "_call_huimeng_image_api",
        ):

            async def fail_direct(*_args, _name=name, **_kwargs):
                raise AssertionError("organization image must not use a direct provider")

            monkeypatch.setattr(nanobanana_grid, name, fail_direct)

    def generator(self):
        return self.module.NanoBananaGridGenerator(
            api_key="poison-config-key", config=_grid_config()
        )


# --- Block 1: provider narrowing moved up to the construction point ----------------------


def test_organization_grid_generator_denies_direct_provider_at_construction() -> None:
    """An organization + a non-newapi provider must be rejected at the construction point.

    `_prepare_organization_image_egress:141-142` already has this verdict, but the 6 call sites of the grid family
    never go through it, so the `org-denied` contract of EG-09b never took effect for them.
    """

    from novelvideo.generators.nanobanana_grid import NanoBananaGridGenerator

    config = _grid_config()
    config["provider"] = "google"

    with model_gateway_request_scope(_egress_context(kind="organization")):
        with pytest.raises(Exception) as denied:
            NanoBananaGridGenerator(api_key="platform-google-key", config=config)

    assert getattr(denied.value, "code", None) == "ORG_EGRESS_DENIED"


def test_platform_grid_generator_keeps_direct_providers() -> None:
    """Under platform/personal identities the direct provider behavior is unchanged -- deny only applies to organizations."""

    from novelvideo.generators.nanobanana_grid import NanoBananaGridGenerator

    config = _grid_config()
    config["provider"] = "google"

    with model_gateway_request_scope(_egress_context(kind="platform")):
        scoped = NanoBananaGridGenerator(api_key="platform-google-key", config=config)
    bare = NanoBananaGridGenerator(api_key="platform-google-key", config=config)

    assert scoped.provider == "google"
    assert bare.provider == "google"


# --- Blocks 2/3/4: all 6 entry points must claim / swap credentials / complete ------------


async def _drive_generate_grid(generator, tmp_path):
    return await generator.generate_grid(
        beats=[
            {
                "beat_number": 1,
                "visual_description": "empty shot",
                "detected_identities": ["__NO_CHARACTER__"],
            }
        ],
        character_map={},
        style="chinese_period_drama",
        output_path=str(tmp_path / "grid.png"),
        rows=1,
        cols=1,
        sketch=True,
        sketch_dir=str(tmp_path / "sketches"),
    )


async def _drive_reformat_sketch(generator, tmp_path):
    source = tmp_path / "source.png"
    source.write_bytes(_png_bytes())
    return await generator.reformat_sketch(
        source_path=str(source),
        output_path=str(tmp_path / "reformatted.png"),
        target_aspect="9:16",
    )


async def _drive_generate_action_grid(generator, tmp_path):
    return await generator.generate_action_grid(
        action_description="A continuous action",
        character_map={},
        style="chinese_period_drama",
        output_path=str(tmp_path / "action.png"),
    )


async def _drive_render_single_panel(generator, tmp_path):
    sketch = tmp_path / "panel-sketch.png"
    sketch.write_bytes(_png_bytes())
    return await generator._render_single_panel_gemini(
        sketch_path=str(sketch),
        prompt="Render this panel",
        output_path=str(tmp_path / "panel.png"),
    )


async def _drive_upscale(generator, tmp_path):
    source = tmp_path / "small.png"
    source.write_bytes(_png_bytes())
    return await generator.upscale_with_nanobanana(
        input_path=str(source),
        output_path=str(tmp_path / "upscaled.png"),
        original_prompt="Original prompt",
    )


async def _drive_single_preview(generator, tmp_path):
    return await generator.generate_single_preview(
        prompt="Style experiment",
        style_config={
            "style_instructions": "ink wash",
            "avoid_instructions": "avoid text",
        },
        output_path=str(tmp_path / "preview.png"),
    )


_GRID_ENTRIES = [
    ("generate_grid", _drive_generate_grid, "image.generate.grid"),
    ("reformat_sketch", _drive_reformat_sketch, "image.edit.sketch_reformat"),
    ("generate_action_grid", _drive_generate_action_grid, "image.generate.action_grid"),
    (
        "_render_single_panel_gemini",
        _drive_render_single_panel,
        "image.generate.render_panel",
    ),
    ("upscale_with_nanobanana", _drive_upscale, "image.edit.upscale"),
    ("generate_single_preview", _drive_single_preview, "image.generate.preview"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "entry,driver,capability",
    _GRID_ENTRIES,
    ids=[name for name, _driver, _capability in _GRID_ENTRIES],
)
async def test_grid_family_organization_call_claims_resolves_and_completes(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
    entry: str,
    driver,
    capability: str,
) -> None:
    context = _egress_context(kind="organization")
    harness = _Harness(monkeypatch, context)

    with model_gateway_request_scope(context):
        generator = harness.generator()
        await driver(generator, tmp_path)

    assert len(harness.posts) == 1, f"{entry} must reach the gateway exactly once"
    assert harness.posts[0]["url"].startswith("https://gateway.invalid/v1/images/")
    assert (
        harness.posts[0]["headers"]["Authorization"]
        == "Bearer request-scoped-grid-key"
    )
    assert len(harness.operation_port.claims) == 1
    claim = harness.operation_port.claims[0]
    assert claim.capability == capability
    assert claim.credential_version == 7
    assert claim.organization_id == "org-grid"
    assert harness.events[:2] == ["claim", "resolve"]
    assert len(harness.operation_port.completed_refs) == 1
    assert harness.operation_port.completed_refs[0].startswith("image:sha256:")


# --- Block 2: the platform branch must pass through byte for byte ---------------------------


@pytest.mark.asyncio
async def test_platform_grid_call_passes_through_the_leaf_unchanged(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """Without an organization identity, the arguments received by the leaf must be identical to before -- no trace, no egress_context.

    `tests/test_newapi_image_gateway.py` calls the leaf directly in 13 places without registering an egress port;
    this assertion guarantees the wrapper does not drag them in.
    """

    from novelvideo.generators import nanobanana_grid

    captured: list[dict[str, object]] = []

    async def fake_leaf(**kwargs):
        captured.append(kwargs)
        return _png_bytes(), "", ""

    monkeypatch.setattr(nanobanana_grid, "_call_newapi_image_api", fake_leaf)

    generator = nanobanana_grid.NanoBananaGridGenerator(
        api_key="platform-newapi-key", config=_grid_config()
    )
    await _drive_generate_grid(generator, tmp_path)

    assert len(captured) == 1
    assert "trace" not in captured[0]
    assert "egress_context" not in captured[0]
    assert captured[0]["api_key"] == "platform-newapi-key"
    assert captured[0]["base_url"] == "https://poison.invalid/v1"


# --- Block 3: two calls with the same capability in one envelope must not collide ----------


@pytest.mark.asyncio
async def test_two_calls_in_one_envelope_do_not_collide(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """When `business_task_id` is hardcoded to `envelope_id`, the second call in the same envelope collides on the key.

    `_render_single_panel_gemini` fans out N paths with `asyncio.gather`, which hits exactly this.
    """

    context = _egress_context(kind="organization")
    harness = _Harness(monkeypatch, context)

    with model_gateway_request_scope(context):
        generator = harness.generator()
        await _drive_generate_grid(generator, tmp_path / "first")
        await _drive_generate_grid(generator, tmp_path / "second")

    assert len(harness.operation_port.claims) == 2
    business_task_ids = {claim.business_task_id for claim in harness.operation_port.claims}
    assert len(business_task_ids) == 2
    assert len(harness.operation_port.completed_refs) == 2


# --- Block 5: the ambient hole in `_generate_image` -------------------------------------


@pytest.mark.asyncio
async def test_generate_image_forwards_ambient_organization_context_to_the_leaf(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """With only an ambient organization identity, the `egress_context=` forwarded to the leaf must not be None.

    Otherwise the reference-image relay silently takes the platform branch instead of `relay_tenant_image_bytes_from_context`.
    The claim itself does not leak (`_prepare_organization_image_egress` falls back internally); what leaks is the relay identity.
    """

    from novelvideo.generators import nanobanana_grid

    context = _egress_context(kind="organization")
    harness = _Harness(monkeypatch, context)

    seen: list[object] = []
    original_leaf = nanobanana_grid._call_newapi_image_api

    async def spy_leaf(**kwargs):
        seen.append(kwargs.get("egress_context"))
        return await original_leaf(**kwargs)

    monkeypatch.setattr(nanobanana_grid, "_call_newapi_image_api", spy_leaf)

    reference = tmp_path / "reference.png"
    reference.write_bytes(_png_bytes())

    with model_gateway_request_scope(context):
        await nanobanana_grid.generate_reference_edit_image(
            prompt="edit under ambient identity",
            reference_images=[str(reference)],
            output_path=str(tmp_path / "edited.png"),
            config=_grid_config(),
        )

    assert seen == [context]
    assert len(harness.posts) == 1
