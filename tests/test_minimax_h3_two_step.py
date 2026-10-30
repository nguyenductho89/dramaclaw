import asyncio

import pytest
from PIL import Image

from novelvideo.agents import minimax_h3_prompt_builder as m


@pytest.fixture(autouse=True)
def _clean_cache():
    m._vision_cache.clear()
    m._vision_locks.clear()
    yield
    m._vision_cache.clear()
    m._vision_locks.clear()


def _img(tmp_path, name="a.png", color=(200, 10, 10)):
    p = tmp_path / name
    Image.new("RGB", (32, 32), color).save(p)
    return str(p)


def _context(tmp_path, with_first_frame=True):
    return m.MiniMaxH3BeatContext(
        mode="ref2va",
        has_first_frame=with_first_frame,
        first_frame_path=_img(tmp_path, "ff.png") if with_first_frame else "",
        visual_description="She walks down the corridor.",
        references=[
            m.MiniMaxH3Reference(tag="<Picture 2>", kind="character", name="Leads", image_path=_img(tmp_path, "c.png", (0, 200, 0))),
            m.MiniMaxH3Reference(tag="<Picture 3>", kind="scene", name="Castle", image_path=_img(tmp_path, "s.png", (0, 0, 200))),
        ],
    )


def test_parse_handles_bullets_leaks_and_unknown_tags():
    text = (
        "<think>hmm</think>\n"
        "- <Picture 1>: A woman in a cream dress stands left of a door.\n"
        "<picture 2> — A man in a black coat with dark wavy hair.\n"
        "<Picture 9>: not asked for\n"
        "random chatter\n"
        "<Picture 3>: \"Quoted\" gothic hall with a marble floor.\n"
    )
    got = m.parse_vision_descriptions(text, ["<Picture 1>", "<Picture 2>", "<Picture 3>"])
    assert set(got) == {"<Picture 1>", "<Picture 2>", "<Picture 3>"}
    assert got["<Picture 1>"].startswith("A woman in a cream dress")
    assert '"' not in got["<Picture 3>"]


def test_parse_ignores_duplicate_tag_lines():
    got = m.parse_vision_descriptions("<Picture 2>: first\n<Picture 2>: second", ["<Picture 2>"])
    assert got == {"<Picture 2>": "first"}


async def test_apply_marks_references_and_sets_first_frame_look(tmp_path, monkeypatch):
    async def fake(items):
        return {t: f"desc of {t}" for t, _l, _p in items}

    monkeypatch.setattr(m, "_describe_images_via_vision", fake)
    ctx = await m.apply_vision_descriptions(_context(tmp_path))
    assert ctx.first_frame_look == "desc of <Picture 1>"
    assert all(r.appearance_source == "vision" for r in ctx.references)
    assert ctx.references[0].appearance_details == "desc of <Picture 2>"
    text = m._build_user_prompt(ctx)
    assert "AS SEEN IN THE IMAGE" in text and "desc of <Picture 3>" in text
    assert "what the vision step saw in the real image" in text
    assert "image attached" not in text


async def test_same_images_are_described_once_even_when_shots_start_together(tmp_path, monkeypatch):
    calls = []

    async def fake(items):
        calls.append([t for t, _l, _p in items])
        await asyncio.sleep(0.05)
        return {t: "x" for t, _l, _p in items}

    monkeypatch.setattr(m, "_describe_images_via_vision", fake)
    ctx = _context(tmp_path)
    results = await asyncio.gather(*[m.apply_vision_descriptions(ctx) for _ in range(6)])
    assert len(calls) == 1
    assert all(r.first_frame_look == "x" for r in results)
    await m.apply_vision_descriptions(ctx)
    assert len(calls) == 1  # later passes hit the cache


async def test_vision_failure_keeps_text_hints_and_never_raises(tmp_path, monkeypatch):
    async def boom(items):
        raise RuntimeError("dashscope down")

    monkeypatch.setattr(m, "_describe_images_via_vision", boom)
    ctx = _context(tmp_path)
    ctx.references[0].appearance_details = "hint from the character sheet"
    out = await m.apply_vision_descriptions(ctx)
    assert out.references[0].appearance_details == "hint from the character sheet"
    assert out.references[0].appearance_source == "text"
    assert out.first_frame_look == ""


async def test_failed_vision_is_not_cached(tmp_path, monkeypatch):
    n = {"calls": 0}

    async def flaky(items):
        n["calls"] += 1
        return {} if n["calls"] == 1 else {t: "ok" for t, _l, _p in items}

    monkeypatch.setattr(m, "_describe_images_via_vision", flaky)
    ctx = _context(tmp_path)
    first = await m.apply_vision_descriptions(ctx)
    second = await m.apply_vision_descriptions(ctx)
    assert first.first_frame_look == "" and second.first_frame_look == "ok"


async def test_no_images_means_no_vision_call(monkeypatch):
    async def never(items):
        raise AssertionError("vision must not run without images")

    monkeypatch.setattr(m, "_describe_images_via_vision", never)
    ctx = m.MiniMaxH3BeatContext(mode="ref2va", has_first_frame=False, references=[
        m.MiniMaxH3Reference(tag="<Picture 1>", kind="character", name="A")])
    assert await m.apply_vision_descriptions(ctx) is ctx


def test_writer_is_text_only_plain_tool_calling():
    import inspect

    src = inspect.getsource(m._build_agent)
    assert "output_type=MiniMaxH3LLMOutput" in src
    assert "output_type=NativeOutput" not in src
    assert not hasattr(m, "NativeOutput")  # deepseek-chat rejects response_format (ADR 0002)


async def test_build_sends_no_images_to_the_writer(tmp_path, monkeypatch):
    seen = {}

    class FakeResult:
        def __init__(self, output):
            self.output = output

    class FakeAgent:
        async def run(self, prompt, deps=None, usage_limits=None):
            seen["prompt"] = prompt
            seen["deps"] = deps
            raise RuntimeError("stop here")

    async def fake_vision(items):
        return {t: f"seen {t}" for t, _l, _p in items}

    monkeypatch.setattr(m, "_describe_images_via_vision", fake_vision)
    monkeypatch.setattr(m, "get_minimax_h3_prompt_agent", lambda: FakeAgent())
    with pytest.raises(RuntimeError, match="stop here"):
        await m.build_minimax_h3_prompt(_context(tmp_path))
    assert isinstance(seen["prompt"], str)  # text only: no BinaryContent list
    assert "seen <Picture 2>" in seen["prompt"]
    assert seen["deps"].references[0].appearance_source == "vision"
