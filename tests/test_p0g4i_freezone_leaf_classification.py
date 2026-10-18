"""freezone leaf dispatch: the criterion is "does it go out to the network", not "what the signature looks like".

`_call_freezone_leaf` used to use `inspect.signature` to judge whether a leaf accepts
`egress_context`, and raised `InvalidTaskEnvelope` when it did not and the envelope belonged to an organization. The signature shape is not
evidence of egress or not, so it was wrong in both directions at once:

- **False block**: the 5 original pure-local ffmpeg leaves (`run_freezone_extract_frames` /
  `run_freezone_video_upscale` / `run_freezone_video_compose` /
  `run_freezone_video_erase` / `run_freezone_audio_separate`, all EG-20a `service/local`
  of `egress-inventory.md:54`, with no egress and no credentials) lacked
  that parameter, so organization members always hit `invalid task envelope` -- the user-reported "upload a video into the script
  generator, and the task stops at ffmpeg keyframe extraction" is exactly this.
- **False pass**: `VAR_KEYWORD` was counted as "accepts the context", so a `**kwargs` leaf was judged compliant,
  and the context was swallowed into the kwargs bag and silently lost.

The fix is an explicit table inside the dispatcher, whose keys are supplied by the **call site**. "Function object -> classification" cannot be used:
the imports of all 19 call sites are inside the runner function bodies, so after monkeypatching the test gets fake objects,
and an object table built at module level would never hit; `leaf.__name__` is the same.

A leaf not listed in the table is **still thrown** under an organization context -- the default is still fail-closed (OI-47 guardrail a,
and OI-32 has ruled the same-family fail-closed to be intentional design).
"""

from __future__ import annotations

import ast
import importlib
import inspect
from pathlib import Path

import pytest

from novelvideo.egress_context import (
    TRUSTED_EGRESS_CONTEXT_KEY,
    TrustedEgressContext,
    TrustedRunnerEnvelope,
)
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference
from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.envelope import InvalidTaskEnvelope

# `run_freezone_video_upscale` has been upgraded to a gateway model pipeline, so it moved from the local table to NETWORK;
# it still keeps the task-level billing exemption, because the two model calls each go through the model quota, to avoid double billing.
AUDITED_LOCAL_LEAVES = frozenset(
    {
        "run_freezone_audio_separate",
        "run_freezone_extract_frames",
        "run_freezone_video_compose",
        "run_freezone_video_erase",
    }
)


def _organization_context(task_type: str = "freezone_extract") -> TrustedEgressContext:
    return TrustedEgressContext(
        envelope_id="envelope-1",
        project_id="project-1",
        task_type=task_type,
        requester_user_id="user-1",
        root_task_id="task-1",
        admission_id="admission-1",
        admitted_at="2026-08-11T04:05:00Z",
        membership_id="membership-1",
        authz_version=11,
        billing_principal=BillingPrincipal(kind="organization", id="org-1"),
        credential=CredentialReference(
            source="organization",
            credential_id="credential-1",
            key_version=7,
            org_id="org-1",
        ),
    )


def _organization_envelope(
    tmp_path: Path,
    *,
    task_type: str = "freezone_extract",
    payload: dict | None = None,
) -> TrustedRunnerEnvelope:
    base = {
        "job_id": "job-1",
        "project_dir": str(tmp_path / "output"),
        "video_path": str(tmp_path / "output" / "source.mp4"),
    }
    base.update(payload or {})
    return TrustedRunnerEnvelope(
        {
            "task_type": task_type,
            "payload": base,
            TRUSTED_EGRESS_CONTEXT_KEY: _organization_context(task_type),
        }
    )


def _project_context(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="project-1",
        project_name="project",
        owner_type="user",
        owner_id="user-1",
        owner_username="user",
        requester_user_id="user-1",
        requester_username="user",
        requester_principals=(("user", "user-1"),),
        effective_role="editor",
        home_node_id="local",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=True,
    )


class _TaskManager:
    def update_progress_for_project(self, *_args, **_kwargs) -> None:
        return None


@pytest.mark.asyncio
async def test_local_ffmpeg_leaf_runs_under_an_organization_context(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Local frame extraction must be let through for organizations -- when this is red, it is exactly the failure the user reported.

    The fake leaf deliberately copies the real signature (`jobs.py:1412` has no `egress_context` parameter). A fake leaf with
    `egress_context` cannot detect this defect: the existing seam cases were written that way, so
    they are all green while production is rejecting people.
    """

    from novelvideo.task_backend.runners import freezone

    project_dir = tmp_path / "output"
    project_dir.mkdir(parents=True, exist_ok=True)
    frame = project_dir / "frame_001.png"
    frame.write_bytes(b"frame")
    calls: list[dict] = []

    async def extract_frames_leaf(
        *,
        project_dir,
        job_id,
        video_path,
        max_frames,
        scene_threshold,
    ):
        calls.append({"job_id": job_id, "max_frames": max_frames})
        return [frame]

    monkeypatch.setattr(freezone, "get_task_manager", lambda: _TaskManager())
    monkeypatch.setattr(
        "novelvideo.freezone.jobs.run_freezone_extract_frames", extract_frames_leaf
    )
    monkeypatch.setattr(
        "novelvideo.freezone.jobs.ensure_freezone_dirs", lambda *_a, **_k: None
    )
    monkeypatch.setattr(
        "novelvideo.api.deps.make_static_url_for_context",
        lambda _ctx, rel, **_k: f"/static/{rel}",
    )

    result = await freezone._run_freezone_extract_async(
        _organization_envelope(tmp_path),
        _project_context(tmp_path),
    )

    assert result["frame_count"] == 1
    assert len(calls) == 1


@pytest.mark.parametrize("leaf_shape", ["explicit", "var_keyword"])
@pytest.mark.asyncio
async def test_unclassified_leaf_is_denied_under_an_organization_context(
    tmp_path: Path,
    leaf_shape: str,
) -> None:
    """A leaf outside the table is still thrown: the default fail-closed has not been loosened by successive changes (guardrail a).

    The sample deliberately uses a **name that does not exist in the table** and hits the dispatcher directly, rather than borrowing some real leaf's
    DENIED classification -- when borrowing a real leaf, once that leaf is wired to the egress context and reclassified as NETWORK
    (OI-56 item 1 is exactly that), this guardrail case would lose coverage along with it. Now it depends only on "unclassified" itself.

    Both signature shapes must be rejected. The `var_keyword` one is where the original criterion leaked: `inspect.signature`
    counts `**kwargs` as "accepts the context", so an unclassified egress leaf was let through, and the context
    was swallowed into the bag and silently lost. The classification criterion does not look at the signature, and rejects both.
    """

    from novelvideo.task_backend.runners.freezone import (
        FREEZONE_LEAF_EGRESS,
        _call_freezone_leaf,
    )

    leaf_calls = 0

    if leaf_shape == "explicit":

        async def unclassified_leaf(*, project_dir, job_id):
            nonlocal leaf_calls
            leaf_calls += 1
            return project_dir / "out.png"

    else:

        async def unclassified_leaf(**kwargs):
            nonlocal leaf_calls
            leaf_calls += 1
            return kwargs["project_dir"] / "out.png"

    assert "leaf_not_in_the_table" not in FREEZONE_LEAF_EGRESS

    with pytest.raises(InvalidTaskEnvelope):
        await _call_freezone_leaf(
            _organization_envelope(tmp_path),
            unclassified_leaf,
            "leaf_not_in_the_table",
            project_dir=tmp_path / "output",
            job_id="job-1",
        )

    assert leaf_calls == 0


@pytest.mark.asyncio
async def test_mask_edit_leaf_receives_the_organization_egress_context(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Image erase must **reach** the leaf for organizations, and what the leaf holds must be the organization identity (OI-56 item 1).

    It really goes out to the network (`jobs.py:190` calls `generate_reference_edit_image`), and previously, with no
    `egress_context` parameter, it was judged DENIED, and under an organization it fell to the `_call_freezone_leaf` fallback branch and threw
    `InvalidTaskEnvelope`. "Reaching" is not enough -- the assertion must land on the context the leaf receives,
    otherwise it replicates the shape of OI-48, "has the parameter but does not catch it".
    """

    from novelvideo.task_backend.runners import freezone

    project_dir = tmp_path / "output"
    project_dir.mkdir(parents=True, exist_ok=True)
    out = project_dir / "freezone_mask_edit" / "job-1.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(b"png")
    seen: list[TrustedEgressContext | None] = []

    async def mask_edit_leaf(
        *,
        project_dir,
        job_id,
        base_path,
        mask_path,
        prompt,
        aspect_ratio,
        image_size,
        quality,
        provider,
        model,
        egress_context=None,
    ):
        seen.append(egress_context)
        return out

    monkeypatch.setattr(freezone, "get_task_manager", lambda: _TaskManager())
    monkeypatch.setattr(
        "novelvideo.freezone.jobs.run_freezone_mask_edit", mask_edit_leaf
    )
    monkeypatch.setattr(
        "novelvideo.freezone.jobs.ensure_freezone_dirs", lambda *_a, **_k: None
    )
    monkeypatch.setattr(
        "novelvideo.api.deps.make_static_url_for_context",
        lambda _ctx, rel, **_k: f"/static/{rel}",
    )

    result = await freezone._run_freezone_mask_edit_async(
        _organization_envelope(
            tmp_path,
            task_type="freezone_mask_edit",
            payload={
                "base_path": str(project_dir / "in.png"),
                "mask_path": str(project_dir / "mask.png"),
                "prompt": "prompt",
            },
        ),
        _project_context(tmp_path),
    )

    assert result["job_id"] == "job-1"
    assert len(seen) == 1
    assert seen[0] is not None and seen[0].is_organization


@pytest.mark.asyncio
async def test_analyze_shots_leaf_receives_the_organization_egress_context(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    """Vision analysis must reach the leaf for organizations, and get the organization identity (OI-56 item 2).

    It has two entry points: `freezone_analyze` and `freezone_video_story`, and the latter runs through
    ffmpeg frame extraction first and only then hits the rejection -- burning compute for nothing.
    """

    from novelvideo.task_backend.runners import freezone

    project_dir = tmp_path / "output"
    out_dir = project_dir / "freezone_analyze" / "job-1"
    out_dir.mkdir(parents=True, exist_ok=True)
    analysis = out_dir / "analysis.json"
    analysis.write_text("{}", encoding="utf-8")
    seen: list[TrustedEgressContext | None] = []

    async def analyze_leaf(
        *,
        project_dir,
        job_id,
        frame_paths,
        provider,
        model,
        analysis_mode,
        duration_sec,
        egress_context=None,
    ):
        seen.append(egress_context)
        return {"output_path": str(analysis), "model": "m", "analysis_mode": "shots"}

    monkeypatch.setattr(freezone, "get_task_manager", lambda: _TaskManager())
    monkeypatch.setattr(
        "novelvideo.freezone.jobs.run_freezone_analyze_shots", analyze_leaf
    )
    monkeypatch.setattr(
        "novelvideo.freezone.jobs.ensure_freezone_dirs", lambda *_a, **_k: None
    )
    monkeypatch.setattr(
        "novelvideo.api.deps.make_static_url_for_context",
        lambda _ctx, rel, **_k: f"/static/{rel}",
    )

    result = await freezone._run_freezone_analyze_async(
        _organization_envelope(
            tmp_path,
            task_type="freezone_analyze",
            payload={"frame_paths": [str(project_dir / "frame_001.png")]},
        ),
        _project_context(tmp_path),
    )

    assert result["job_id"] == "job-1"
    assert len(seen) == 1
    assert seen[0] is not None and seen[0].is_organization


def test_local_table_is_exactly_the_audited_leaves() -> None:
    """The local table strictly matches the leaves that still do not go out to the network (guardrail b).

    Every one maps to EG-20a and shares the same source as the EE billing exemption set `feature_billing.py:389-399`.
    """

    from novelvideo.task_backend.runners.freezone import (
        FREEZONE_LEAF_EGRESS,
        LeafEgress,
    )

    local = {
        name
        for name, rule in FREEZONE_LEAF_EGRESS.items()
        if rule.egress is LeafEgress.LOCAL
    }

    assert local == AUDITED_LOCAL_LEAVES
    assert all(
        FREEZONE_LEAF_EGRESS[name].eg_id == "EG-20a" for name in AUDITED_LOCAL_LEAVES
    )

    # The DENIED bucket is locked down too: it is not a "to-do list", and stuffing new names into it quietly widens the rejection surface.
    # After OI-56 wired the last two (mask_edit / analyze_shots) to the egress context, this bucket became empty --
    # unclassified leaves still go through the fallback rejection of `_call_freezone_leaf`, with no need to list names in the table.
    denied = {
        name
        for name, rule in FREEZONE_LEAF_EGRESS.items()
        if rule.egress is LeafEgress.DENIED
    }
    assert denied == set()


def test_every_rule_names_a_well_formed_atomic_eg_id() -> None:
    """`eg_id` must look like an atomic ID in the inventory, and placeholder strings are never allowed through.

    `generate_freezone_audio_eleven_music` once survived a whole round hanging a `"EG-unregistered"`: the only
    assertion that hit a literal was the 5 local leaves' `"EG-20a"`, and nobody checked whatever else was written (OI-56 item 3).
    This case only validates the shape -- cross-repo checking of the EE `egress-inventory.md` is not something a unit test can do.
    """

    import re

    from novelvideo.task_backend.runners.freezone import FREEZONE_LEAF_EGRESS

    malformed = {
        name: rule.eg_id
        for name, rule in FREEZONE_LEAF_EGRESS.items()
        if not re.fullmatch(r"EG-\d+[a-z]?", rule.eg_id)
    }
    assert not malformed, f"These eg_id values are not atomic IDs: {malformed}"


def test_classification_matches_the_real_leaf_signatures() -> None:
    """Walk the **real** leaf objects and assert their classification is self-consistent -- fake leaves cannot stop the same kind of regression.

    "Declares `egress_context`" and "classified as NETWORK" must be equivalent in both directions: a NETWORK leaf that does not declare it
    cannot receive it from the dispatcher (TypeError); a LOCAL/DENIED leaf that declares it is actually going out to the network and is misclassified.
    Once DENIED gets the parameter it should be reclassified as NETWORK, and this case will force a table edit then (the exit of OI-56).

    `**kwargs` never counts: a context swallowed into the bag is as good as not passed, which is exactly the leak
    in the `VAR_KEYWORD` branch of the original criterion.
    """

    from novelvideo.task_backend.runners.freezone import (
        FREEZONE_LEAF_EGRESS,
        LeafEgress,
    )

    for name, rule in sorted(FREEZONE_LEAF_EGRESS.items()):
        module = importlib.import_module(rule.module)
        leaf = getattr(module, name)
        parameters = inspect.signature(leaf).parameters
        declares_context = "egress_context" in parameters
        has_var_keyword = any(
            parameter.kind is inspect.Parameter.VAR_KEYWORD
            for parameter in parameters.values()
        )

        assert not has_var_keyword, f"{rule.module}.{name} swallows the classification contract with **kwargs"
        if rule.egress is LeafEgress.NETWORK:
            assert declares_context, f"{rule.module}.{name} is classified as egress but does not accept egress_context"
        else:
            assert not declares_context, (
                f"{rule.module}.{name} is classified as {rule.egress.value} but accepts egress_context"
            )


def test_every_dispatch_site_names_a_classified_leaf() -> None:
    """The 20 call sites are matched into the table one by one; a new unclassified call site turns it red.

    `leaf_name` is a required positional argument, not optional -- omitting it is a `TypeError`, not a silent pass.
    """

    from novelvideo.task_backend.runners import freezone
    from novelvideo.task_backend.runners.freezone import FREEZONE_LEAF_EGRESS

    source = Path(inspect.getsourcefile(freezone)).read_text(encoding="utf-8")
    tree = ast.parse(source)

    named: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if not isinstance(node.func, ast.Name):
            continue
        if node.func.id != "_call_freezone_leaf":
            continue
        assert len(node.args) >= 3, "The call site does not explicitly declare leaf_name"
        leaf_name = node.args[2]
        assert isinstance(leaf_name, ast.Constant) and isinstance(
            leaf_name.value, str
        ), "leaf_name must be a literal; indirect lookup is as good as no classification"
        named.append(leaf_name.value)

    # 19 -> 20: `generate_freezone_text`, brought in by f33ac189 (#279) of `origin/staging`,
    # is exactly the shape the previous case named in its prediction.
    assert len(named) == 20
    assert set(named) <= set(FREEZONE_LEAF_EGRESS)


# The only two non-leaf names in `novelvideo.freezone.jobs` / `.text_node` called directly by runners:
# `ensure_freezone_dirs` (`jobs.py:358-378`, only mkdir) and `bind_story_script_assets`
# (`text_node.py:606-`, only backfills URL strings). Neither goes out to the network or takes credentials, checked one by one.
NON_LEAF_HELPERS = frozenset({"ensure_freezone_dirs", "bind_story_script_assets"})


def test_no_leaf_module_import_reaches_the_network_around_the_dispatcher() -> None:
    """Every name imported from a leaf's module is either classified or a checked local helper.

    The previous case counted **call sites**, which cannot stop a new leaf from simply not going through the dispatcher: directly
    `from novelvideo.freezone.text_node import generate_freezone_text` and then
    `await generate_freezone_text(...)`, the call-site count does not move, the classification table needs no change,
    and the organization identity bypasses the gate just like that. `f33ac189` of `origin/staging`
    (Freezone AI text generation, #279) is exactly this shape, and would have happened the day it was merged.

    The criterion does not hard-code the module list -- the leaf modules are given by the classification table's own `rule.module`, so as the table grows
    new modules, the coverage follows automatically.
    """

    from novelvideo.task_backend.runners import freezone
    from novelvideo.task_backend.runners.freezone import FREEZONE_LEAF_EGRESS

    leaf_modules = {rule.module for rule in FREEZONE_LEAF_EGRESS.values()}
    tree = ast.parse(Path(inspect.getsourcefile(freezone)).read_text(encoding="utf-8"))

    imported: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module in leaf_modules:
            for alias in node.names:
                imported[alias.asname or alias.name] = node.module

    unclassified = {
        name: module
        for name, module in imported.items()
        if name not in FREEZONE_LEAF_EGRESS and name not in NON_LEAF_HELPERS
    }
    assert not unclassified, (
        f"These names come from leaf modules but have no classification, so the organization identity cannot reach their egress points: {unclassified}"
    )

    # A classified leaf may only appear as an argument of `_call_freezone_leaf` and must not be called directly.
    called_directly = sorted(
        {
            node.func.id
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in FREEZONE_LEAF_EGRESS
        }
    )
    assert not called_directly, f"These leaves bypass the dispatcher: {called_directly}"


def test_organization_identity_reaches_the_image_egress_gate_through_the_scope() -> None:
    """The basis for classifying `convert_control_frame_to_sketch` as NETWORK must be confirmed by a case.

    It gained an `egress_context` parameter, but does **not** keep threading it into `generate_grid` -- that is a method with 39
    parameters and no such parameter, and threading it in would amount to an OI-48-style sweep of the whole internal chain (guardrail c).
    No threading is needed: OI-48 already did a central binding for all runner dispatch at `run_core.py:695`, and
    the organization gate at `nanobanana_grid.py:128-137` reads the scope when the explicit argument is None. This case pins
    that premise; if it goes red, the narrowing of "not threading the parameter" does not hold and explicit pass-down must be done.
    """

    import asyncio

    from novelvideo.generators.nanobanana_grid import (
        _prepare_organization_image_egress,
    )
    from novelvideo.model_gateway_runtime import model_gateway_scope_for_runner
    from novelvideo.ports.egress import EgressError

    envelope = TrustedRunnerEnvelope(
        {
            "task_type": "mainline_director_control_sketch",
            "payload": {},
            TRUSTED_EGRESS_CONTEXT_KEY: _organization_context(
                "mainline_director_control_sketch"
            ),
        }
    )

    async def probe() -> None:
        await _prepare_organization_image_egress(
            egress_context=None,
            provider="openai",
            capability="image.director.control_sketch",
            request={"beat": 1},
        )

    with model_gateway_scope_for_runner(envelope):
        with pytest.raises(EgressError) as excinfo:
            asyncio.run(probe())

    assert excinfo.value.code == "ORG_EGRESS_DENIED"
