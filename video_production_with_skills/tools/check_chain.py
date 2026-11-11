#!/usr/bin/env python3
"""Mechanical checks for chain JSON files (the rules of longform-minimax-h3-script-review that a script can decide).

  python3 video_production_with_skills/tools/check_chain.py [chain_01 chain_02 ...]     (default: every chain of the episode)

The episode is picked with SERIES and EP (default science_humor and ep01). A chain is checked against the Storyboard of
<episode>/script.md: shot count, dialogue text and speaker. Prints one line per problem and exits 1 when any exists.
It decides nothing about wording quality: that stays with the review skill.
"""
import json, os, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERIES = os.environ.get("SERIES", "science_humor")
EP = os.environ.get("EP", "ep01")
EP_DIR = ROOT / "video_production_with_skills/series" / SERIES / EP
REL = f"video_production_with_skills/series/{SERIES}"
SECTIONS = ["subject_definitions:", "summary:", "retention_analysis:", "detailed_description:", "overall_soundscape:", "non_diegetic_music:"]
VOICES = [f"{REL}/assets/voices/einstein.wav", f"{REL}/assets/voices/newton.wav"]
SHEETS = [f"{REL}/assets/characters/einstein_sheet.png", f"{REL}/assets/characters/newton_sheet.png"]
REAL_NAMES = re.compile(r"\b(Einstein|Newton|Galileo|NASA|Apollo)\b")
LIP_CLOSE = "Exactly as the voice stops, the lips close and the jaw ceases all speaking motion."
NO_TEXT = "There are no subtitles, captions, on-screen text, logos or watermarks anywhere in frame."
REALTIME = "All motion happens at natural real-time speed, not slow motion."
MOVES = {"pull-out": r"moves straight back", "push-in": r"moves straight in", "pan": r"turns sideways", "arc": r"circles about"}


def syllables(text: str) -> int:
    total = 0
    for w in re.findall(r"[A-Za-z']+", text):
        w = w.lower().replace("'", "")
        if w == "earth":
            total += 1
            continue
        n = len(re.findall(r"[aeiouy]+", w))
        if w.endswith("e") and not w.endswith(("le", "ee")) and n > 1:
            n -= 1
        if w.endswith("ed") and n > 1 and not w.endswith(("ted", "ded")):
            n -= 1
        total += max(n, 1)
    return total


def storyboard() -> tuple[dict[str, list[dict]], dict[str, str]]:
    """chain id -> [{speaker, line, move}] from the Storyboard shot table, and chain id -> angle from the chain table."""
    text = (EP_DIR / "script.md").read_text()
    block = text[text.index("**Bảng shot**"):]
    chains: dict[str, list[dict]] = {}
    for line in block.splitlines():
        if not re.match(r"\| \d\d, \d \|", line):
            continue
        c = [x.strip() for x in line.strip("|").split("|")]
        m = re.search(r'^(\w+): "(.*)"$', c[1])
        chains.setdefault(f"chain_{c[0][:2]}", []).append({"speaker": m.group(1), "line": m.group(2), "move": c[7].split(" ")[0]})
    angles = {}
    ct = text[text.index("**Bảng chain**"):text.index("**Bảng shot**")]
    for line in ct.splitlines():
        m = re.match(r"\| (\d\d) \| .*? \| ([\w-]+) \|", line)
        if m:
            angles[f"chain_{m.group(1)}"] = m.group(2)
    return chains, angles


def check(name: str, chain: dict, plan: list[dict]) -> list[str]:
    out: list[str] = []
    bad = lambda rule, msg: out.append(f"{name}: [{rule}] {msg}")  # noqa: E731
    if chain.get("aspect_ratio") != "16:9":
        bad("16", f"aspect_ratio {chain.get('aspect_ratio')!r}, must be '16:9'")
    frames = chain.get("frames")
    if not isinstance(frames, int) or (frames - 5) % 17 or frames < 192:
        bad("17", f"frames {frames!r}: must be 17k+5 and at least 192 for a shot with dialogue")
    if chain.get("checkpoint") != "ref2va":
        bad("21", f"checkpoint {chain.get('checkpoint')!r}, must be 'ref2va'")
    if chain.get("voice_refs") != VOICES:
        bad("8", f"voice_refs must be {VOICES}")
    if chain.get("reference_images") != SHEETS:
        bad("21", f"reference_images must be {SHEETS}")
    num = name.split("_")[1]
    if chain.get("start_image") != f"{REL}/{EP}/keyframes/images/chain_{num}_k0.png":
        bad("21", f"start_image {chain.get('start_image')!r}, must be the K0 of this chain")
    shots = chain.get("shots", [])
    if len(shots) != len(plan):
        bad("15", f"{len(shots)} shot(s), the Storyboard has {len(plan)}")
    sec = round(frames / 24, 2) if isinstance(frames, int) else 8.0
    for i, (shot, want) in enumerate(zip(shots, plan), 1):
        at = f"shot {i}"
        pos = [shot.find(s) for s in SECTIONS]
        if -1 in pos or pos != sorted(pos):
            bad("19", f"{at}: the six sections {SECTIONS} must all be present, in this order")
            continue
        if not shot.rstrip().endswith("non_diegetic_music:\nN/A"):
            bad("23", f"{at}: non_diegetic_music must be N/A")
        if shot.count(f"[Shot {i}]") < 1 or "[Shot 1]" in shot and i > 1:
            bad("19", f"{at}: label [Shot {i}] missing or a wrong label present")
        body = shot[shot.index("detailed_description:"):]
        ds = re.findall(r"<d>(.*?)</d>", body, re.S)
        if len(ds) != 1:
            bad("7", f"{at}: exactly one <d>...</d> expected, found {len(ds)}")
            continue
        d = ds[0]
        if not d.startswith("[English] "):
            bad("4", f"{at}: <d> must start with '[English] '")
        text = d.replace("[English] ", "", 1)
        if '"' in text:
            bad("4", f"{at}: double quotes inside <d>")
        if text != want["line"]:
            bad("5", f"{at}: dialogue {text!r} differs from the script {want['line']!r}")
        starts = [float(x) for x in re.findall(r"At (\d+\.\d+) seconds", body)]
        if starts != sorted(starts) or len(set(starts)) != len(starts) or (starts and starts[-1] > sec):
            bad("17", f"{at}: 'At X seconds' marks must strictly increase and stay within {sec} s: {starts}")
        speak = re.search(r"At (\d+\.\d+) seconds <Subject \d> \(S[12]\) says", body)
        t0 = float(speak.group(1)) if speak else 1.0
        end = re.search(r"At (\d+\.\d+) seconds <Subject \d> finishes", body)
        t1 = float(end.group(1)) if end else 6.3
        rate = syllables(text) / max(t1 - t0, 0.1)
        if t0 < 1.0 or rate > 3.0 or sec - t1 < 1.2 or sec - t1 > 2.0:
            bad("6", f"{at}: speech {t0}-{t1} s, {syllables(text)} syllables = {rate:.2f}/s (need start >= 1.0, <= 3/s, end 1.2-2.0 s before the end)")
        who = 1 if want["speaker"] == "Einstein" else 2
        if f"<Subject {who}> (S{who}) says" not in body or f"<Audio {who}>" not in body:
            bad("8", f"{at}: the speaker must be <Subject {who}> (S{who}) with <Audio {who}>")
        if LIP_CLOSE not in body:
            bad("6", f"{at}: lip-close sentence missing after </d>")
        if NO_TEXT not in body or REALTIME not in body:
            bad("19", f"{at}: the real-time sentence and the no-text sentence are both required")
        move = want["move"]
        if move == "static":
            if "The camera holds this framing until the final frame." not in body:
                bad("22", f"{at}: a static shot needs 'The camera holds this framing until the final frame.'")
            if re.search(r"The camera (?:moves|turns|circles)", body):
                bad("22", f"{at}: the Storyboard says static but the text moves the camera")
        elif not re.search(MOVES[move], body) or "The camera holds this framing" in body:
            bad("22", f"{at}: the Storyboard movement is {move}: describe exactly that one movement and not the holding sentence")
        if len(re.findall(r"The camera (?:moves|turns|circles)", body)) > 1:
            bad("22", f"{at}: more than one camera movement")
        outside = REAL_NAMES.sub("", re.sub(r"<d>.*?</d>", "", shot, flags=re.S)) != re.sub(r"<d>.*?</d>", "", shot, flags=re.S)
        if outside:
            bad("51", f"{at}: a real name outside <d> (scene text uses 'the first man' / 'the second man' and the sheets)")
        for w in ("slowly", "as before", "the same man"):
            if w in shot.lower():
                bad("25", f"{at}: forbidden wording {w!r}")
        if i == 1 and "<Picture 1>" not in shot:
            bad("21", f"{at}: the first shot must define <Picture 1> as the first frame")
        if i > 1 and "<Picture 1>" in shot:
            bad("21", f"{at}: only the first shot defines <Picture 1>")
    return out


def main() -> int:
    plans, _angles = storyboard()
    names = sys.argv[1:] or sorted(plans)
    problems: list[str] = []
    for name in names:
        f = EP_DIR / "chains" / f"{name}.json"
        if not f.exists():
            problems.append(f"{name}: no {f.relative_to(ROOT)}")
            continue
        problems += check(name, json.loads(f.read_text()), plans.get(name, []))
    print("\n".join(problems) if problems else f"ok: {len(names)} chain(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
