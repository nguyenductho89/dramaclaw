#!/usr/bin/env python3
"""Spec-driven image review with a small vision model (Haiku). Generic: nothing here knows a particular episode.
See SKILL.md for the workflow; `examples/` has a spec and a calibration set.

  review.py prompt-frames <spec.json>                       prompt (stdout): per-image checklist built from the spec
  review.py prompt-pairs  <spec.json>                       prompt (stdout): consecutive-frame continuity checklist
  review.py verdict <spec.json> --frames r1.json [r2.json ...] [--pairs p1.json ...] [--measured m.json] [--json out.json]
  review.py measured-from-qwen-report <keyframes_report.json>   -> measured.json (growth_vs_prev) on stdout
  review.py calibrate <spec.json> <calibration.json> --frames r1.json [...] [--pairs ...]   recall/false-alarm per dimension
Exit code: 0 all PASS, 1 any MANUAL/WARN-only, 2 any FAIL.
"""
import argparse, json, re, sys
from collections import Counter
from pathlib import Path

LEVEL = {"wide": 0, "medium": 1, "close": 2}


# ----------------------------------------------------------------------------- spec
def load_spec(path: Path) -> dict:
    s = json.loads(path.read_text())
    s["_dir"] = (Path(s["images_dir"]) if Path(s["images_dir"]).is_absolute() else Path.cwd() / s["images_dir"]).resolve()
    s["_pat"] = re.compile(s.get("sequence_pattern", r"^(?P<seq>.+)_(?P<i>\d+)$"))
    frames = {}
    for p in sorted(s["_dir"].glob(s.get("glob", "*.png"))):
        m = s["_pat"].match(p.stem)
        seq, idx = (m.group("seq"), int(m.group("i"))) if m else (p.stem, 0)
        frames[p.stem] = {"path": p, "seq": seq, "i": idx}
    for name, f in frames.items():
        prev = next((o for o, g in frames.items() if g["seq"] == f["seq"] and g["i"] == f["i"] - 1), None)
        f["prev"] = prev
        fr = (s.get("sequences", {}).get(f["seq"], {}).get("framings") or [])
        f["framing"] = fr[f["i"]] if f["i"] < len(fr) else None
        f["pf"] = fr[f["i"] - 1] if f["i"] >= 1 and f["i"] - 1 < len(fr) else None
        if f["framing"] and f["pf"]:
            f["camera"] = "push_in" if LEVEL[f["framing"]] > LEVEL[f["pf"]] else "pull_out" if LEVEL[f["framing"]] < LEVEL[f["pf"]] else "none"
        else:
            f["camera"] = None
    s["_frames"] = frames
    return s


def seq_cfg(s, f):
    return s.get("sequences", {}).get(f["seq"], {})


# ----------------------------------------------------------------------------- prompts
def prompt_frames(s: dict) -> str:
    cast = "\n".join(f'- {c["id"]}: {c["describe"]} (expected count: {c.get("count", 1)})' for c in s["cast"])
    props = "\n".join(f'- {p["id"]}: {p["describe"]}' for p in s.get("props", [])) or "- (none)"
    forb = ", ".join(s.get("scene", {}).get("forbidden", [])) or "(none)"
    lines = []
    for name, f in s["_frames"].items():
        persist = seq_cfg(s, f).get("must_persist", [])
        lines.append(f'{name}: {f["path"]}' + (f'\n    must-persist items for THIS image: {json.dumps(persist, ensure_ascii=False)}' if persist else ""))
    persist_all = {name: seq_cfg(s, f).get("must_persist", []) for name, f in s["_frames"].items()}
    return f"""You are a careful visual QA reviewer for generated film stills. Use the Read tool to open each image file below, one at a time, and fill the checklist for EACH image. Never skip an image. Never guess: use "unclear" when you cannot tell. Judge only what is visible.

Cast (people who should appear):
{cast}
Props to track:
{props}
Forbidden in the picture: {forbidden if (forbidden:=forb) else ''}

Images:
{chr(10).join(lines)}

For EACH image return these fields:
- cast: object mapping each cast id to the number of times that person appears in the foreground/midground (a duplicate, clone or extra smaller copy counts as an extra appearance).
- extra_foreground_people: number of OTHER large people not in the cast (tiny distant background figures do not count).
- props: object mapping each prop id to {{"visible": true/false, "holder": "<cast id>" | "nobody" | "unclear"}}.
- persist: object mapping EVERY must-persist item text of that image (copy the text exactly) to "yes" | "no" | "unclear".
- forbidden_found: list of forbidden things you can see (empty list if none).
- positions: object mapping each cast id to its horizontal position in the image as the viewer sees it: "left" | "center" | "right" (use "unclear" if you cannot tell). Report it for every cast member, always.
- cropped: object {{"head": bool, "hands": bool, "feet": bool}} = a cast member's head / hands / feet is cut off by the image edge.
- artifacts: list of {{"type": "smudge|text|watermark|glitch|anatomy|blur|other", "where": "short place description", "severity": "low|medium|high"}} (smudges, blotches, garbled faces, extra fingers, melted objects, stray text).
- pose: one short sentence describing what each cast member is doing.
- confidence: "low" | "medium" | "high".

Return ONLY one JSON object keyed by the image file stem (file name without .png). No other text."""


def prompt_pairs(s: dict) -> str:
    pairs = [(f["prev"], n) for n, f in s["_frames"].items() if f["prev"]]
    if not pairs:
        sys.exit("no consecutive frames found (check sequence_pattern)")
    lines = [f'{a}->{b}: A={s["_frames"][a]["path"]}  B={s["_frames"][b]["path"]}' for a, b in pairs]
    return f"""You compare consecutive frames of ONE continuous camera take. Frame B is the moment right after frame A. Use the Read tool to open both images of each pair and answer the checklist. Never skip a pair. Use "unclear" instead of guessing.

Pairs:
{chr(10).join(lines)}

For EACH pair return:
- same_location: "yes" | "no" | "unclear" (same place, same background objects, same time of day).
- background_changes: list of background objects that appeared, disappeared or changed shape between A and B (empty list if none).
- people_moved: "yes" | "no" | "unclear" — did any person change position on the ground relative to the background (NOT counting a change of pose or a camera move)?
- props_changed: list of props that changed holder, disappeared or appeared (empty list if none).
- lighting_changed: "yes" | "no" | "unclear".
- camera_change: "none" | "push_in" | "pull_out" | "pan" | "cut" | "unclear" (push_in = the same scene seen larger because the camera moved closer; cut = a different viewpoint or composition).
- confidence: "low" | "medium" | "high".

Return ONLY one JSON object keyed by "A->B" using the file stems exactly as written. No other text."""


# ----------------------------------------------------------------------------- verdict
def clean(text: str) -> dict:
    t = text.strip()
    t = re.sub(r"^```(?:json)?", "", t).rstrip("`").strip()
    return json.loads(t)


def yes(v): return str(v).strip().lower().startswith("y") or v is True
def no(v): return str(v).strip().lower().startswith("n") or v is False
def unclear(v): return str(v).strip().lower() in ("unclear", "none", "") and v is not False


def frame_findings(s, name, r, measured):
    f = s["_frames"][name]; out = []
    def add(sev, dim, msg): out.append((sev, dim, msg))
    cast_r = r.get("cast", {})
    for c in s["cast"]:
        got, want = cast_r.get(c["id"]), c.get("count", 1)
        if got is None: add("MANUAL", "cast", f'{c["id"]} count missing')
        elif int(got) != want: add("FAIL", "cast", f'{c["id"]} appears {got}x (expected {want})' + (" — clone/duplicate" if int(got) > want else " — missing"))
    ex = r.get("extra_foreground_people")
    if ex not in (None, 0, "0"): add("FAIL", "cast", f"{ex} extra foreground person(s) not in the cast")
    for p in s.get("props", []):
        pr = r.get("props", {}).get(p["id"], {})
        exp = (seq_cfg(s, f).get("prop_holder", {}) or {}).get(p["id"], p.get("holder"))
        if not pr: add("MANUAL", "props", f'{p["id"]} not answered'); continue
        holder = str(pr.get("holder", "unclear")).lower()
        if holder == "unclear": add("MANUAL", "props", f'{p["id"]} holder unclear')
        elif exp is None: continue
        elif not pr.get("visible", False) or holder == "nobody":
            if p.get("required_visible", True): add("FAIL", "props", f'{p["id"]} not visible (should be held by {exp})')
        elif holder != exp: add("FAIL", "props", f'{p["id"]} held by {holder} (expected {exp})')
    for item, v in (r.get("persist") or {}).items():
        if no(v): add("FAIL", "continuity", f"missing: {item}")
        elif unclear(v): add("MANUAL", "continuity", f"cannot tell: {item}")
    if r.get("forbidden_found"): add("FAIL", "forbidden", ", ".join(map(str, r["forbidden_found"])))
    known = [k.lower() for k in seq_cfg(s, f).get("known_issues", [])]
    for a in r.get("artifacts", []) or []:
        desc = f'{a.get("type")} at {a.get("where")} ({a.get("severity")})'
        if any(k in desc.lower() or k in str(a.get("where", "")).lower() for k in known): add("INFO", "artifact", desc + " — known issue")
        elif a.get("severity") == "high": add("FAIL", "artifact", desc)
        elif a.get("severity") == "medium": add("WARN", "artifact", desc)
        else: add("INFO", "artifact", desc)
    cr = r.get("cropped") or {}
    for part in ("head", "hands", "feet"):
        if yes(cr.get(part)) and not (part == "feet" and f["framing"] in ("medium", "close")) and not (part == "hands" and f["framing"] == "close"):
            add("WARN" if part != "head" else "FAIL", "framing", f"{part} cut by the frame")
    m = (measured or {}).get(name, {})
    if f["camera"] == "push_in" and m.get("growth_vs_prev") is not None:
        need = s.get("min_push_in_growth", 1.4)
        if m["growth_vs_prev"] < need: add("WARN", "framing", f'push-in only {m["growth_vs_prev"]:.2f}x vs previous frame (< {need}x)')
    if str(r.get("confidence", "")).lower() == "low": add("MANUAL", "confidence", "reviewer confidence low")
    return out


def pair_findings(s, key, r):
    a, b = key.split("->"); f = s["_frames"][b]; out = []
    def add(sev, dim, msg): out.append((sev, dim, msg))
    if no(r.get("same_location")): add("FAIL", "continuity", "location differs between the two frames")
    elif unclear(r.get("same_location")): add("MANUAL", "continuity", "same location unclear")
    if yes(r.get("people_moved")): add("FAIL", "continuity", "a person changed place on the ground between frames")
    elif unclear(r.get("people_moved")): add("MANUAL", "continuity", "people position change unclear")
    for k, sev in (("background_changes", "WARN"), ("props_changed", "FAIL")):
        if r.get(k): add(sev, "continuity", f"{k}: {'; '.join(map(str, r[k]))}")
    if yes(r.get("lighting_changed")): add("WARN", "continuity", "lighting changed")
    exp, got = f["camera"], str(r.get("camera_change", "unclear")).lower()
    if exp and got not in ("unclear", exp): add("WARN", "framing", f"camera change is '{got}', spec expects '{exp}'")
    if str(r.get("confidence", "")).lower() == "low": add("MANUAL", "confidence", "reviewer confidence low")
    return out


RANK = {"left": 0, "center": 1, "right": 2}


def order_findings(s, name, run):
    """Cast members swapped sides between a frame and the one before it (same sequence), from each run's `positions`."""
    f = s["_frames"][name]; prev = f.get("prev"); out = []
    if not prev or prev not in run or name not in run: return None
    def order(k):
        pos = (run[k] or {}).get("positions") or {}
        ranks = {c: RANK.get(str(v).lower()) for c, v in pos.items()}
        if len(ranks) < 2 or any(v is None for v in ranks.values()): return None
        return sorted(ranks, key=lambda c: ranks[c])
    a, b = order(prev), order(name)
    if a is None or b is None: return [("MANUAL", "continuity", "left/right positions unclear")]
    if a != b: out.append(("FAIL", "continuity", f"cast swapped sides: left-to-right was {' , '.join(a)}, now {' , '.join(b)}"))
    return out


def votes_to_verdict(per_vote):
    """per_vote: list of findings lists (one per Haiku run). FAIL/WARN/INFO decided by majority; any split on FAIL -> MANUAL."""
    def top(fs):
        sevs = {x[0] for x in fs}
        return "FAIL" if "FAIL" in sevs else "MANUAL" if "MANUAL" in sevs else "WARN" if "WARN" in sevs else "PASS"
    tops = [top(f) for f in per_vote]
    c = Counter(tops).most_common()
    verdict = c[0][0]
    if len(c) > 1 and c[0][1] == c[1][1] or (len(per_vote) > 1 and ("FAIL" in tops) and tops.count("FAIL") * 2 <= len(tops)):
        verdict = "MANUAL"
    notes = []
    seen = set()
    for fs in per_vote:
        for sev, dim, msg in fs:
            if (dim, msg) not in seen: seen.add((dim, msg)); notes.append((sev, dim, msg))
    if len(set(tops)) > 1: notes.append(("MANUAL", "agreement", f"runs disagree: {tops}"))
    return verdict, notes


def cmd_verdict(s, frames_files, pairs_files, measured_file, out_json):
    measured = json.loads(Path(measured_file).read_text()) if measured_file else {}
    fr_runs = [clean(Path(p).read_text()) for p in frames_files]
    pr_runs = [clean(Path(p).read_text()) for p in pairs_files] if pairs_files else []
    rows, worst = [], 0
    order = {"PASS": 0, "WARN": 1, "MANUAL": 1, "FAIL": 2}
    keys = sorted({k for run in fr_runs for k in run})
    for k in keys:
        if k not in s["_frames"]: rows.append((k, "MANUAL", [("MANUAL", "spec", "image not in spec/glob")])); continue
        v, notes = votes_to_verdict([frame_findings(s, k, run.get(k, {}), measured) for run in fr_runs if k in run])
        rows.append((k, v, notes))
    for k in keys:
        if k not in s["_frames"] or not s["_frames"][k].get("prev"): continue
        per = [x for x in (order_findings(s, k, run) for run in fr_runs) if x is not None]
        if per:
            v, notes = votes_to_verdict(per)
            if v != "PASS" or notes: rows.append((f'{s["_frames"][k]["prev"]}->{k} [order]', v, notes))
    pkeys = sorted({k for run in pr_runs for k in run})
    for k in pkeys:
        if k.split("->")[-1] not in s["_frames"]: continue
        v, notes = votes_to_verdict([pair_findings(s, k, run.get(k, {})) for run in pr_runs if k in run])
        rows.append((k, v, notes))
    print(f'{"item":<28} {"verdict":<7} findings')
    for name, v, notes in rows:
        worst = max(worst, order[v])
        txt = "; ".join(f"[{d}] {m}" + ("" if sv in ("FAIL", "MANUAL") else f" ({sv})") for sv, d, m in notes) or "-"
        print(f"{name:<28} {v:<7} {txt}")
    print("\nFAIL/MANUAL items: the main model looks at the real image(s) before concluding. Only the user approves a storyboard.")
    if out_json:
        Path(out_json).write_text(json.dumps([{"item": n, "verdict": v, "findings": [{"severity": a, "dimension": b, "message": c} for a, b, c in notes]} for n, v, notes in rows], indent=1, ensure_ascii=False))
    return 2 if any(order[v] == 2 for _n, v, _x in rows) else 1 if worst else 0


def cmd_calibrate(s, cal_file, frames_files, pairs_files):
    cal = json.loads(Path(cal_file).read_text())  # [{"item": "stem or A->B", "expect": [{"dimension": "...", "contains": "text"}], "clean": bool}]
    fr_runs = [clean(Path(p).read_text()) for p in frames_files]
    pr_runs = [clean(Path(p).read_text()) for p in pairs_files] if pairs_files else []
    stats = {}
    for c in cal:
        item = c["item"]
        fs = ([frame_findings(s, item, run[item], {}) for run in fr_runs if item in run] if "->" not in item
              else [pair_findings(s, item, run[item]) for run in pr_runs if item in run])
        found = [(d, m.lower()) for f in fs for sv, d, m in f if sv in ("FAIL", "WARN", "MANUAL")]
        for e in c.get("expect", []):
            st = stats.setdefault(e["dimension"], {"hit": 0, "miss": 0, "false_alarm": 0, "clean_ok": 0})
            ok = any(d == e["dimension"] and re.search(e["contains"], m, re.I) for d, m in found)  # `contains` is a regex
            st["hit" if ok else "miss"] += 1
        if c.get("clean"):
            for d in {x[0] for x in found}:
                stats.setdefault(d, {"hit": 0, "miss": 0, "false_alarm": 0, "clean_ok": 0})["false_alarm"] += 1
            if not found:
                for d in stats: stats[d]["clean_ok"] += 1
    print(f'{"dimension":<14} {"caught":>6} {"missed":>6} {"false alarms on clean images":>30}')
    for d, st in sorted(stats.items()): print(f'{d:<14} {st["hit"]:>6} {st["miss"]:>6} {st["false_alarm"]:>30}')
    print("\nTrust a dimension only when it catches the known defects here AND raises no false alarms on the clean images.")
    return 0


def cmd_measured(report: Path):
    rep = json.loads(report.read_text()); out = {}
    for k, v in rep.items():
        m = re.search(r"\(([\d.]+)x prev\)", v.get("note", ""))
        if m: out[k] = {"growth_vs_prev": float(m.group(1))}
    print(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for n in ("prompt-frames", "prompt-pairs"): sub.add_parser(n).add_argument("spec", type=Path)
    v = sub.add_parser("verdict"); v.add_argument("spec", type=Path); v.add_argument("--frames", nargs="+", required=True); v.add_argument("--pairs", nargs="*"); v.add_argument("--measured"); v.add_argument("--json")
    c = sub.add_parser("calibrate"); c.add_argument("spec", type=Path); c.add_argument("calibration", type=Path); c.add_argument("--frames", nargs="+", required=True); c.add_argument("--pairs", nargs="*")
    m = sub.add_parser("measured-from-qwen-report"); m.add_argument("report", type=Path)
    a = ap.parse_args()
    if a.cmd == "measured-from-qwen-report": sys.exit(cmd_measured(a.report))
    spec = load_spec(a.spec)
    if a.cmd == "prompt-frames": print(prompt_frames(spec))
    elif a.cmd == "prompt-pairs": print(prompt_pairs(spec))
    elif a.cmd == "verdict": sys.exit(cmd_verdict(spec, a.frames, a.pairs, a.measured, a.json))
    else: sys.exit(cmd_calibrate(spec, a.calibration, a.frames, a.pairs))
