"""Tests for the gates in `video_production_with_skills/tools/` and the episode files they guard.

`tools/` is not a package, so the modules are loaded by path. Only the stdlib-only tools are imported
(`qwen_prompt_gate`, `approve_keyframes`); the others need numpy, cv2 or a ComfyUI box, so they are checked
statically with `ast`.
"""
from __future__ import annotations

import ast
import importlib.util
import json
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
WORK = REPO / "video_production_with_skills"
TOOLS = WORK / "tools"
EP = WORK / "series" / "science_humor" / "ep01"


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, TOOLS / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


gate = load("qwen_prompt_gate")
approve = load("approve_keyframes")


def record(**over) -> dict:
    rec = {
        "k": 0, "mode": "compose", "framing": "medium", "storyboard_ref": "chain 01, shot 1, start",
        "images": ["plate.png", "a.png", "b.png"],
        "rewritten_prompt": "Place the man from <image2> and the man from <image3> into the scene of <image1>, "
                            "with <image1> as the canvas.",
        "wh_ratio": "", "ratio_follow": "<image1>",
    }
    rec.update(over)
    return rec


# --- machine_check: one passing record, then one failing case per rule

def test_valid_record_passes():
    assert gate.machine_check(record()) == []


@pytest.mark.parametrize("over, code", [
    ({"rewritten_prompt": "   "}, "E1"),
    ({"rewritten_prompt": "Place <image2> and <image3> into <image1> with \"quoted\" text."}, "E7"),
    ({"rewritten_prompt": "Put <image2> into <image1>.", "images": ["only.png"]}, "E9"),
    ({"rewritten_prompt": "Đặt <image2> và <image3> vào <image1>."}, "E15"),
    ({"rewritten_prompt": "Place <image2> and <image3> into <image1>.\nSecond line."}, "E15"),
    ({"rewritten_prompt": "Place <image2> and <image3> into <image1> at 16:9."}, "E15"),
    ({"rewritten_prompt": "Place <image2> and <image3> into <image1>..."}, "E15"),
    ({"wh_ratio": "16:9"}, "E16"),
    ({"ratio_follow": ""}, "E16"),
    ({"images": ["p.png"] + [f"{i}.png" for i in range(10)]}, "N1"),
])
def test_machine_check_flags_each_rule(over, code):
    problems = gate.machine_check(record(**over))
    assert any(p.startswith(code) for p in problems), problems


def test_machine_check_reports_missing_field():
    rec = record()
    del rec["images"]
    assert gate.machine_check(rec)[0].startswith("E16: missing field images")


def test_digest_follows_the_prompt_text_only_in_the_hashed_fields():
    a, b = record(), record()
    assert gate.digest(a) == gate.digest(b)
    assert gate.digest(a) == gate.digest(record(storyboard_ref="other"))  # not hashed
    assert gate.digest(a) != gate.digest(record(rewritten_prompt="Place <image2> and <image3> into <image1>."))


# --- main(): check / record flow against a temp prompts file

def run_gate(monkeypatch, capsys, *argv) -> tuple[int | str, str]:
    monkeypatch.setattr("sys.argv", ["qwen_prompt_gate.py", *argv])
    try:
        code = gate.main()
    except SystemExit as exc:
        code = exc.code
    return code, capsys.readouterr().out


def test_check_record_check_flow(tmp_path, monkeypatch, capsys):
    prompts = tmp_path / "qwen_keyframe_prompts.json"
    prompts.write_text(json.dumps({"chain_01": [record()]}))
    report = WORK / "camera-research.md"  # any existing file under the repo (record stores its path relative to the repo root)

    code, out = run_gate(monkeypatch, capsys, "check", str(prompts))
    assert code == 1 and "NOT REVIEWED" in out

    code, _ = run_gate(monkeypatch, capsys, "record", str(prompts))
    assert isinstance(code, str) and "--review" in code  # record without a review file stops with a message

    code, out = run_gate(monkeypatch, capsys, "record", str(prompts), "--review", str(report))
    assert code == 0 and "recorded" in out

    code, out = run_gate(monkeypatch, capsys, "check", str(prompts))
    assert code == 0 and "reviewed" in out and "NOT REVIEWED" not in out


def test_edited_prompt_needs_a_new_review(tmp_path, monkeypatch, capsys):
    prompts = tmp_path / "p.json"
    prompts.write_text(json.dumps({"chain_01": [record()]}))
    run_gate(monkeypatch, capsys, "record", str(prompts), "--review", str(WORK / "camera-research.md"))
    prompts.write_text(json.dumps({"chain_01": [record(rewritten_prompt="Place <image2> and <image3> into <image1> now.")]}))
    code, out = run_gate(monkeypatch, capsys, "check", str(prompts))
    assert code == 1 and "NOT REVIEWED" in out


def test_missing_prompts_file_stops_with_a_message(tmp_path, monkeypatch, capsys):
    code, _ = run_gate(monkeypatch, capsys, "check", str(tmp_path / "nope.json"))
    assert isinstance(code, str) and "no prompts file" in code


# --- the repo root regression: tools live one level below video_production_with_skills/

def test_approve_keyframes_root_is_the_repo_and_episode_exists():
    assert approve.ROOT == REPO
    assert approve.EP_DIR.is_dir()


@pytest.mark.parametrize("tool, var", [
    ("approve_keyframes", "ROOT"), ("check_video", "ROOT"), ("qwen_prompt_gate", "ROOT"),
    ("comfy_qwen", "R"), ("gemini_webai_images", "R"), ("make_ken_burns_transition", "R"),
])
def test_tools_that_need_the_repo_root_use_parents_2(tool, var):
    tree = ast.parse((TOOLS / f"{tool}.py").read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == var for t in node.targets):
            assert "parents[2]" in ast.unparse(node.value), ast.unparse(node)
            return
    pytest.fail(f"{tool}.py has no top-level {var}")


# --- episode files the gates guard

def chain_ids_in_storyboard() -> set[str]:
    text = (EP / "script.md").read_text()
    block = text[text.index("**Bảng chain**"):text.index("**Bảng shot**")]
    return {f"chain_{m.group(1)}" for m in re.finditer(r"^\| (\d\d) \|", block, re.M)}


def test_every_storyboard_chain_has_exactly_one_k0_prompt_that_passes_the_machine_check():
    prompts = json.loads((EP / "keyframes" / "qwen_keyframe_prompts.json").read_text())
    assert set(prompts) == chain_ids_in_storyboard()
    for chain, items in prompts.items():
        assert [r["k"] for r in items] == [0], chain
        assert gate.machine_check(items[0]) == [], chain
        assert set(items[0].get("present", ["einstein", "newton"])) <= {"einstein", "newton"}, chain


def test_k0_plates_exist_or_have_a_prompt():
    prompts = json.loads((EP / "keyframes" / "qwen_keyframe_prompts.json").read_text())
    plates = json.loads((EP / "image_prompts.json").read_text())["backgrounds"]
    for chain, items in prompts.items():
        plate = Path(items[0]["images"][0])
        assert plate.stem in plates, f"{chain}: no prompt for plate {plate.stem}"
        if plate.stem in ("orchard", "moon"):
            assert (REPO / plate).exists(), f"{chain}: {plate} is missing"


def test_k0_prompt_file_is_recorded_in_the_review_ledger():
    ledger = EP / "keyframes" / "review.json"
    assert ledger.exists(), "run qwen_prompt_gate.py record after the review"
    reviews = json.loads(ledger.read_text())
    prompts = json.loads((EP / "keyframes" / "qwen_keyframe_prompts.json").read_text())
    for chain, items in prompts.items():
        assert gate.digest(items[0]) in reviews, f"{chain}: prompt changed after its review"


# --- check_chain.py: mechanical chain checks

chain_tool = load("check_chain")


def chain_and_plan(name: str = "chain_01"):
    plans, _ = chain_tool.storyboard()
    chain = json.loads((EP / "chains" / f"{name}.json").read_text())
    return name, chain, plans[name]


def test_every_chain_of_the_episode_passes():
    plans, _ = chain_tool.storyboard()
    assert len(plans) == 19
    for name, plan in plans.items():
        _, chain, _p = chain_and_plan(name)
        assert chain_tool.check(name, chain, plan) == [], name


@pytest.mark.parametrize("mutate, rule", [
    (lambda c: c.update(aspect_ratio="9:16"), "16"),
    (lambda c: c.update(frames=190), "17"),
    (lambda c: c.update(voice_refs=list(reversed(c["voice_refs"]))), "8"),
    (lambda c: c.update(start_image="video_production_with_skills/series/science_humor/ep01/backgrounds/orchard.png"), "21"),
    (lambda c: c.update(shots=c["shots"][:1]), "15"),
    (lambda c: c["shots"].__setitem__(0, c["shots"][0].replace("Easy.", "Simple.")), "5"),
    (lambda c: c["shots"].__setitem__(0, c["shots"][0].replace("Exactly as the voice stops, the lips close and the jaw ceases all speaking motion.", "")), "6"),
    (lambda c: c["shots"].__setitem__(0, c["shots"][0].replace("natural film look", "natural film look, Newton")), "51"),
    (lambda c: c["shots"].__setitem__(0, c["shots"][0].replace("natural film look", "natural film look, moving slowly")), "25"),
    (lambda c: c["shots"].__setitem__(0, c["shots"][0].replace("N/A", "soft piano")), "23"),
    (lambda c: c["shots"].__setitem__(1, c["shots"][1] + " The camera moves straight in toward the first man."), "22"),
])
def test_chain_checker_flags_each_rule(mutate, rule):
    name, chain, plan = chain_and_plan("chain_01")
    mutate(chain)
    assert any(f"[{rule}]" in p for p in chain_tool.check(name, chain, plan)), rule


def test_chain_checker_flags_speech_that_is_too_fast():
    name, chain, plan = chain_and_plan("chain_01")
    shot = chain["shots"][0].replace("At 6.30 seconds", "At 3.10 seconds").replace("At 3.00 seconds", "At 2.00 seconds")
    chain["shots"][0] = shot
    assert any("[6]" in p for p in chain_tool.check(name, chain, plan))
