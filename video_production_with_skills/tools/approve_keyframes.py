#!/usr/bin/env python3
"""Keyframe review gate: record that a HUMAN approved the current keyframe images, before any video is rendered.

  python3 video_production_with_skills/tools/approve_keyframes.py approve [--note "..."]
  python3 video_production_with_skills/tools/approve_keyframes.py check <image.png> [...]
  python3 video_production_with_skills/tools/approve_keyframes.py status

The episode is picked with SERIES and EP (default science_humor and ep01).

`approve` writes <episode>/keyframes/approved.json with the SHA-256 of every picked keyframe image
(<episode>/keyframes/images/*.png, never candidates/). run_batch.sh `videos` calls `check` for every chain whose
start_image lives under keyframes/images/ and refuses to render when the image is missing from approved.json or was
changed after approval (regenerated, edited...). Only run `approve` after the user has looked at the keyframes and said
so — the agent must not approve on its own.
"""
import argparse, hashlib, json, os, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EP_DIR = ROOT / "video_production_with_skills/series" / os.environ.get("SERIES", "science_humor") / os.environ.get("EP", "ep01")
KF = EP_DIR / "keyframes"
IMAGES = KF / "images"
APPROVAL = KF / "approved.json"


def picked_images() -> list[Path]:
    return sorted(IMAGES.glob("*.png"))


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def rel(p: Path) -> str:
    return str(p.resolve().relative_to(ROOT))


def cmd_approve(note: str) -> int:
    files = {rel(p): sha(p) for p in picked_images()}
    APPROVAL.write_text(json.dumps({"approved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "note": note, "files": files},
                                   indent=1, ensure_ascii=False) + "\n")
    print(f"approved {len(files)} keyframe image(s) -> {APPROVAL}")
    return 0


def cmd_check(images: list[str]) -> int:
    if not APPROVAL.exists():
        print(f"NOT APPROVED: {APPROVAL} is missing — review the keyframes and run approve_keyframes.py approve")
        return 1
    ok = json.loads(APPROVAL.read_text()).get("files", {})
    bad = 0
    for img in images:
        p = (ROOT / img) if not Path(img).is_absolute() else Path(img)
        key = rel(p) if p.exists() else img
        if key not in ok:
            print(f"NOT APPROVED: {key} is not in approved.json"); bad += 1
        elif p.exists() and sha(p) != ok[key]:
            print(f"CHANGED AFTER APPROVAL: {key} — review it again and re-run approve"); bad += 1
    return 1 if bad else 0


def cmd_status() -> int:
    if not APPROVAL.exists():
        print("no approval recorded"); return 1
    a = json.loads(APPROVAL.read_text())
    stale = [k for k, h in a["files"].items() if not (ROOT / k).exists() or sha(ROOT / k) != h]
    new = [rel(p) for p in picked_images() if rel(p) not in a["files"]]
    print(f"approved {a['approved_at']} note={a.get('note')!r}: {len(a['files'])} file(s), changed/missing {stale or 'none'}, unapproved new {new or 'none'}")
    return 1 if (stale or new) else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["approve", "check", "status"])
    ap.add_argument("images", nargs="*")
    ap.add_argument("--note", default="")
    a = ap.parse_args()
    sys.exit({"approve": lambda: cmd_approve(a.note), "check": lambda: cmd_check(a.images), "status": cmd_status}[a.cmd]())
