import pytest

from novelvideo.verification.image_verifier import ImageVerifier
from novelvideo.verification.image_verifier import resolve_verification_scene_context
from novelvideo.verification.models import VerificationResult


class _FakeAgent:
    def __init__(self) -> None:
        self.task = ""

    async def run(self, payload):
        self.task = payload[0]
        return type(
            "RunResult",
            (),
            {
                "output": VerificationResult(
                    passed=True,
                    score=9,
                    issues=[],
                    summary="ok",
                    suggested_action="none",
                )
            },
        )()


@pytest.mark.asyncio
async def test_image_verifier_marks_time_baked_scene_as_locked_light(monkeypatch, tmp_path):
    image_path = tmp_path / "sketch.jpg"
    image_path.write_bytes(b"image")
    monkeypatch.setattr("novelvideo.verification.image_verifier.compress_image", lambda _p: b"jpeg")

    verifier = ImageVerifier()
    fake_agent = _FakeAgent()
    verifier._agent = fake_agent

    await verifier.verify_sketch(
        str(image_path),
        "Water pools on the bathroom floor at night.",
        [],
        "Bathroom",
        "night",
        resolved_scene_name="Bathroom_leak_night",
        time_baked=True,
        prompt_time_of_day="night",
    )

    assert "Resolved scene: Bathroom_leak_night" in fake_agent.task
    assert "Time/lighting verification: a scene image with the time baked in was hit" in fake_agent.task
    assert "lock its built-in night lighting" in fake_agent.task
    assert "do not require an extra relight" in fake_agent.task


@pytest.mark.asyncio
async def test_image_verifier_marks_unbaked_scene_as_relight_target(monkeypatch, tmp_path):
    image_path = tmp_path / "sketch.jpg"
    image_path.write_bytes(b"image")
    monkeypatch.setattr("novelvideo.verification.image_verifier.compress_image", lambda _p: b"jpeg")

    verifier = ImageVerifier()
    fake_agent = _FakeAgent()
    verifier._agent = fake_agent

    await verifier.verify_sketch(
        str(image_path),
        "Water pools on the bathroom floor in the daytime.",
        [],
        "Bathroom",
        "day",
        resolved_scene_name="Bathroom_leak",
        time_baked=False,
        prompt_time_of_day="day",
    )

    assert "Resolved scene: Bathroom_leak" in fake_agent.task
    assert "Time/lighting verification: the current scene image does not have the time baked in" in fake_agent.task
    assert "the picture should present day through generation/relight" in fake_agent.task


def test_resolve_verification_scene_context_uses_time_baked_plate(tmp_path):
    plate_dir = tmp_path / "assets" / "scenes" / "Bathroom_night"
    plate_dir.mkdir(parents=True)
    (plate_dir / "master.png").write_bytes(b"night")

    context = resolve_verification_scene_context(
        tmp_path,
        {
            "beat_number": 1,
            "scene_ref": {"scene_id": "Bathroom", "variant_id": ""},
            "time_of_day": "night",
        },
    )

    assert context == {
        "scene_id": "Bathroom",
        "resolved_scene_name": "Bathroom_night",
        "time_baked": True,
        "prompt_time_of_day": "night",
    }
