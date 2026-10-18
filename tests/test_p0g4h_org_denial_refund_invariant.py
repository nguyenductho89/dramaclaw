"""OI-48 block 6: refund correctness of a whole voice batch rests on an unguarded implicit invariant.

Chain: `indextts2_fal.py` decides `ORG_EGRESS_DENIED`
  → `indextts2_beat_audio_task.py:596 raise`
  -> `:622` swallows it into `result.failed`
  -> `task_backend/runners/audio.py:106` raises only when `generated == 0 and failed`
  -> `task_backend/run_core.py:721` returns this feature's credit reservation.

In other words, **a refund happens only when the whole batch fails**. Today the whole batch fails because `ORG_EGRESS_DENIED` is a
property of (context, provider) and is uniform across beats - the safety is incidental, not designed.
Once "some beats denied, some succeeded" occurs, `generated > 0` bypasses `:106`, and the credits for the denied part
are silently charged.

This file pins the invariant itself without changing refund logic: once uniformity is broken, the test goes red and points to
the refund gap. Fixing the gap is tracked in a separate OI entry.
"""

from __future__ import annotations

import inspect

import pytest

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference


def _organization_context() -> TrustedEgressContext:
    return TrustedEgressContext(
        envelope_id="envelope-1",
        project_id="project-1",
        task_type="beat_audio",
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


@pytest.mark.asyncio
async def test_org_denial_is_uniform_across_beat_level_inputs(tmp_path) -> None:
    """Source of uniformity: denial depends only on (context, provider), not on beat-level inputs.

    Both are constant within one whole-batch generation, so denial is uniform across beats, `generated` must be 0,
    and `runners/audio.py:106` therefore always triggers the refund. If the criterion ever starts reading beat-level inputs
    (text, voice, output path), uniformity breaks and this assertion goes red - at that point
    `generated > 0` would bypass the refund condition.
    """

    from novelvideo.generators.indextts2_fal import IndexTTS2FalClient

    # provider does not match the organization identity -> the organization must be denied.
    client = IndexTTS2FalClient(provider="fal", egress_context=_organization_context())

    verdicts = []
    for index, text in enumerate(("hello", "a much longer line of dialogue", "")):
        result = await client.generate(
            prompt=text,
            audio_url=f"https://example.invalid/voice-{index}.wav",
            output_path=tmp_path / f"beat-{index}.mp3",
            emotion_prompt="calm" if index % 2 else "",
        )
        verdicts.append((result.success, result.error))

    assert verdicts == [(False, "ORG_EGRESS_DENIED")] * 3


def test_refund_requires_the_whole_batch_to_fail() -> None:
    """Pin down the actual condition "refund only when the whole batch fails", so it does not look like "refund on any failure"."""

    from novelvideo.task_backend.runners import audio

    source = inspect.getsource(audio)
    assert "if result.generated == 0 and result.failed:" in source


@pytest.mark.asyncio
async def test_denied_batch_reports_zero_generated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Behavior: when the whole organization batch is denied, `generated == 0`; the refund condition holds."""

    from novelvideo.audio import indextts2_beat_audio_task as task
    from novelvideo.generators.tts_generator import TTSResult

    class _DeniedClient:
        async def generate(self, **kwargs: object) -> TTSResult:
            return TTSResult(success=False, error="ORG_EGRESS_DENIED")

    beats = [
        {"beat_num": 1, "speaker": "A", "dialogue": "hello"},
        {"beat_num": 2, "speaker": "B", "dialogue": "world"},
    ]

    class _Store:
        project_dir = "/tmp/oi48-refund"
        db_path = "/tmp/oi48-refund/db.sqlite"

        async def get_beats_as_dicts(self, episode: int) -> list[dict[str, object]]:
            return list(beats)

    result = await task.run_indextts2_beat_audio_generation(
        store=_Store(),
        username="user-1",
        project="project-1",
        episode=1,
        beat_numbers=[1, 2],
        generator=_DeniedClient(),
        egress_context=_organization_context(),
    )
    assert result.generated == 0
