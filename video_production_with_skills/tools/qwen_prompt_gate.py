#!/usr/bin/env python3
"""Gate for every Qwen-Image 2.1 prompt this project sends: the prompt must be written and reviewed with the
qwen-image-prompting skill (.claude/skills/qwen-image-prompting/SKILL.md). qwen_images.py calls require() before any GPU work.

  python3 video_production_with_skills/tools/qwen_prompt_gate.py check  <qwen_keyframe_prompts.json>
      machine checks of the skill's measurable rules + whether each prompt is recorded as reviewed
  python3 video_production_with_skills/tools/qwen_prompt_gate.py record <qwen_keyframe_prompts.json> --review <review.md>
      after a skill review of these prompts found no violation: store each prompt's SHA-256 with the review file

The prompts file is {"<scene>": [{"k", "mode", "framing", "storyboard_ref", "images": [...], "rewritten_prompt", "wh_ratio",
"ratio_follow"}, ...]}. The review record sits next to it (review.json). Any change to a prompt, its image list or
its output fields changes its hash, so it has to be reviewed again.
"""
import argparse, hashlib, json, re, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAX_REFERENCE_IMAGES = 10  # skill N1
_TAG = re.compile(r"<image(\d+)>")
_SIZE = re.compile(r"\b\d+\s*:\s*\d+\b|\b\d{3,5}\s*[x×]\s*\d{3,5}\b|\b[2-8]K\b|\b\d{3,4}p\b")
_VIET = re.compile("[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]", re.IGNORECASE)


def review_file(prompts_file) -> Path:
    return Path(prompts_file).with_name("review.json")


def digest(record: dict) -> str:
    return hashlib.sha256(json.dumps({k: record[k] for k in ("rewritten_prompt", "wh_ratio", "ratio_follow", "images")},
                                     sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def machine_check(record: dict) -> list[str]:
    """The skill's rules that can be checked mechanically. Empty list = no violation."""
    out = []
    for key in ("rewritten_prompt", "wh_ratio", "ratio_follow", "images"):
        if key not in record:
            return [f"E16: missing field {key}"]
    text, n = record["rewritten_prompt"], len(record["images"])
    if not text.strip():
        out.append("E1: empty prompt")
    if _VIET.search(json.dumps(record, ensure_ascii=False)):
        out.append("E15: Vietnamese text in the record (prompt and every field must be English)")
    if "\n" in text:
        out.append("E15: must be a single continuous paragraph (newline found)")
    if _SIZE.search(text):
        out.append(f"E15: resolution or aspect ratio in the prompt ({_SIZE.search(text).group(0)})")
    if "..." in text or "…" in text:
        out.append("E15: ellipsis")
    if '"' in text:
        out.append("E7: double quotes are only for text rendered in the image")
    if bool(record["wh_ratio"]) == bool(record["ratio_follow"]):
        out.append("E16: exactly one of wh_ratio / ratio_follow must have a value")
    if not 1 <= n <= MAX_REFERENCE_IMAGES:
        out.append(f"N1: {n} input images (1..{MAX_REFERENCE_IMAGES})")
    tags = {int(t) for t in _TAG.findall(text)}
    if n == 1 and tags:
        out.append("E9: a single input image takes no <imageN> tags")
    if n >= 2:
        missing, extra = sorted(set(range(1, n + 1)) - tags), sorted(tags - set(range(1, n + 1)))
        if missing:
            out.append(f"E9/E10: images never referenced: {missing}")
        if extra:
            out.append(f"E9: tags beyond the {n} input images: {extra}")
    if record["ratio_follow"] and not re.fullmatch(r"<image\d+>", record["ratio_follow"]):
        out.append("E16: ratio_follow must be an <imageN> tag")
    return out


def _reviews(prompts_file) -> dict:
    f = review_file(prompts_file)
    return json.loads(f.read_text()) if f.exists() else {}


def require(record: dict, label: str, prompts_file) -> None:
    """Stop unless the prompt passes the machine checks AND was reviewed with the skill (recorded by `record`)."""
    problems = machine_check(record)
    if problems:
        raise SystemExit(f"QWEN PROMPT REJECTED {label}: " + "; ".join(problems))
    if digest(record) not in _reviews(prompts_file):
        raise SystemExit(f"QWEN PROMPT NOT REVIEWED {label}: review it with the qwen-image-prompting skill, then run "
                         "qwen_prompt_gate.py record <prompts.json> --review <review.md>")


def records(prompts_file):
    for scene, items in json.loads(Path(prompts_file).read_text()).items():
        for rec in items:
            yield f"{scene}_k{rec['k']}", rec


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["check", "record"])
    ap.add_argument("prompts")
    ap.add_argument("--review", help="record: the skill review report that found no violation")
    a = ap.parse_args()
    reviews, bad = _reviews(a.prompts), 0
    if a.cmd == "record" and (not a.review or not Path(a.review).exists()):
        raise SystemExit("record needs --review <file>: the qwen-image-prompting review of these prompts")
    for label, rec in records(a.prompts):
        problems = machine_check(rec)
        if a.cmd == "check":
            status = "REJECTED: " + "; ".join(problems) if problems else ("reviewed" if digest(rec) in reviews else "NOT REVIEWED")
            bad += status != "reviewed"
            print(f"{label:<14} {status}")
        elif problems:
            bad += 1
            print(f"{label:<14} not recorded, machine check failed: {'; '.join(problems)}")
        else:
            reviews[digest(rec)] = {"prompt": label, "review": str(Path(a.review).resolve().relative_to(ROOT)),
                                    "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            print(f"{label:<14} recorded")
    if a.cmd == "record":
        review_file(a.prompts).write_text(json.dumps(reviews, indent=1, ensure_ascii=False) + "\n")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
