"""Continuous storyboard keyframes with Qwen-Image 2.1 on a LOCAL ComfyUI (rented GPU box).

  python video_production_with_skills/tools/qwen_images.py keyframes <episode_dir> [--n 2] [--only chain_01] [--until 0] [--redo] [--dry-run]

Prompts and image lists come from <episode_dir>/keyframes/qwen_keyframe_prompts.json (written with the script-to-qwen-storyboard skill).
Every prompt must pass qwen_prompt_gate.py: the machine checks of the qwen-image-prompting skill and a recorded skill review;
anything else stops before GPU work. `images` is the exact order sent to the node; "@prev" is the keyframe chosen just before.
The node sizes the output to <image1> (skill N4), so ratio_follow must be <image1>.

Qwen-Image 2.1 is licensed for research and evaluation only: test output only, not for a monetised release.
"""
import argparse
import io
import json
import sys
import time
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import comfy_qwen as q  # noqa: E402  (ComfyUI helpers: loaders, sampler, upload, render)
import qwen_prompt_gate as gate  # noqa: E402

R = HERE.parents[1]
MAX_IMAGES = gate.MAX_REFERENCE_IMAGES


def compose_graph(prompt: str, image_names: list[str], seed: int, steps: int = q.EDIT_STEPS) -> dict:
    """image_names[0] is the edit target (image_1), the rest are references (image_2...). The latent comes from
    TextEncodeQwenImage21 output 2, so the result keeps image_1's size, as the node requires for edits."""
    if not 1 <= len(image_names) <= MAX_IMAGES:
        raise ValueError(f"TextEncodeQwenImage21 takes 1..{MAX_IMAGES} images, got {len(image_names)}")
    graph = {**q.loaders(), "9": {"class_type": "QwenImage21Cache", "inputs": {"model": ["1", 0], "device": "auto", "dtype": "default"}}}
    images_inputs = {}
    for k, name in enumerate(image_names, start=1):
        node = str(100 + k)
        graph[node] = {"class_type": "LoadImage", "inputs": {"image": name}}
        images_inputs[f"images.image_{k}"] = [node, 0]
    graph["4"] = {"class_type": "TextEncodeQwenImage21",
                  "inputs": {"clip": ["2", 0], "vae": ["3", 0], "prompt": prompt, "negative_prompt": "",
                             "resolution": q.EDIT_RESOLUTION, **images_inputs}}
    return {**graph, **q.sampler(["9", 0], ["4", 2], seed, steps)}


def finish(data: bytes) -> bytes:
    """Edits run at resolution 1536, then shrink to the frame size (see comfy_qwen.py docstring)."""
    im = Image.open(io.BytesIO(data)).convert("RGB")
    if abs(im.width / im.height - q.WIDTH / q.HEIGHT) > 0.01:
        print(f"WARNING: output is {im.size}, not 16:9 — image_1 was not 16:9, so the resize below stretches it", flush=True)
    if im.size != (q.WIDTH, q.HEIGHT):
        im = im.resize((q.WIDTH, q.HEIGHT), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def contact_sheet(rows: list[list[Path]], out: Path, thumb_w: int = 240) -> None:
    rows = [r for r in rows if r]
    if not rows:
        return
    thumbs = [[Image.open(p).convert("RGB") for p in row] for row in rows]
    w, h = thumbs[0][0].size
    th = round(h * thumb_w / w)
    sheet = Image.new("RGB", (thumb_w * max(len(r) for r in thumbs), th * len(thumbs)), "white")
    for y, row in enumerate(thumbs):
        for x, im in enumerate(row):
            sheet.paste(im.resize((thumb_w, th)), (x * thumb_w, y * th))
    sheet.save(out, quality=88)


def run_jobs(jobs: list[dict], dest_dir: Path, dry: bool) -> list[list[Path]]:
    """job: name, graph(seed) -> graph, files (paths to upload, in image order), seeds."""
    rows, timing = [], []
    for job in jobs:
        paths = []
        names = [] if dry else [q.upload(f) for f in job["files"]]
        for k, seed in enumerate(job["seeds"], start=1):
            graph = job["graph"](names or [f.name for f in job["files"]], seed)
            if dry:
                print(f"{job['name']}_s{k}: nodes {sorted(graph)} steps {graph['6']['inputs']['steps']} images {[f.name for f in job['files']]}")
                continue
            t0 = time.time()
            try:
                data = finish(q.render(graph))
            except Exception as exc:  # one failed seed must not kill the batch
                print(f"{job['name']}_s{k}: FAILED — {exc}", flush=True)
                continue
            dest_dir.mkdir(parents=True, exist_ok=True)
            path = dest_dir / f"{job['name']}_s{k}.png"
            path.write_bytes(data)
            secs = round(time.time() - t0, 1)
            timing.append({"name": job["name"], "candidate": k, "seed": seed, "seconds": secs})
            print(f"{path.name}  {secs}s", flush=True)
            paths.append(path)
        rows.append(paths)
    if timing:
        (dest_dir.parent / "timing_qwen.json").write_text(json.dumps(timing, indent=1) + "\n")
    return rows


def seeds_for(base: int, n: int, salt: int = 0) -> list[int]:
    return [base + salt * 100 + k for k in range(n)]


def _kf_score(path: Path, cc, sheets, prev_px: float | None, mode: str, expect_order: tuple | None) -> tuple[float, float, str, tuple]:
    """Score one keyframe candidate: min over the two characters of the best SFace cosine among the big faces (>= 35 px),
    minus 1 unless exactly two big faces; for a `reframe` keyframe also minus 1 unless the faces grew at least 1.25x
    against the previous keyframe (the camera really pushed in); and minus 1 when the two characters stand on the other
    sides than in the previous keyframe (2026-11-10: Qwen swapped Barnaby and Ambrose between consecutive frames and the
    identity score alone could not see it). Returns (score, mean face px, note, left-to-right character order)."""
    import cv2
    img = cv2.imread(str(path))
    if img is None:
        return -9.0, 0.0, "unreadable", ()
    _cv2, _fs, _det, rec = cc.face_tools()
    big = sorted([(x, h, e) for x, h, e in cc.faces_in(img) if h >= 35], key=lambda t: t[0])
    cos = lambda e, n: max((float(rec.match(e, r, cv2.FaceRecognizerSF_FR_COSINE)) for r in sheets[n]), default=-1.0)  # noqa: E731
    best = {n: max((cos(e, n) for _x, _h, e in big), default=-1.0) for n in sheets}
    order = tuple(max(sheets, key=lambda n: cos(e, n)) for _x, _h, e in big)
    px = sum(h for _x, h, _e in big) / len(big) if big else 0.0
    score = min(best.values()) - (0 if len(big) == 2 else 1)
    grow = f", faces {px:.0f}px" + (f" ({px / prev_px:.2f}x prev)" if prev_px else "")
    if mode == "reframe" and prev_px and px < 1.25 * prev_px:  # hard gate; image-review-haiku warns below 1.4x
        score -= 1
    if len(big) == 2 and expect_order and len(set(order)) == 2 and order != tuple(expect_order):
        score -= 1
        grow += f", SIDES SWAPPED (left-to-right {'/'.join(order)}, expected {'/'.join(expect_order)})"
    return score, px, f"{len(big)} big face(s), barnaby {best['barnaby']:.2f} ambrose {best['ambrose']:.2f}{grow}", order


def _order_of(path: Path, cc, sheets) -> tuple:
    import cv2
    _cv2, _fs, _det, rec = cc.face_tools()
    big = sorted([(x, h, e) for x, h, e in cc.faces_in(cv2.imread(str(path))) if h >= 35], key=lambda t: t[0])
    return tuple(max(sheets, key=lambda n: max((float(rec.match(e, r, cv2.FaceRecognizerSF_FR_COSINE)) for r in sheets[n]), default=-1.0)) for _x, _h, e in big)


def cmd_keyframes(episode_dir: Path, n: int, seed: int, only: str | None, dry: bool, redo: bool, rounds: int = 3, until: int | None = None) -> None:
    """K0..K4 per chain go to <episode_dir>/keyframes/images/chain_NN_kK.png; each keyframe's n candidates are scored (identity,
    a real push-in for `reframe`, unchanged left/right order), the best is kept, and below 0.45 more rounds of new seeds are
    tried before the next keyframe is built on it. Resumes from keyframes already chosen unless --redo."""
    import check_video as cc
    prompts_file = episode_dir / "keyframes" / "qwen_keyframe_prompts.json"
    scenes = json.loads(prompts_file.read_text())
    for scene, items in scenes.items():
        for rec in items:
            gate.require(rec, f"{scene}_k{rec['k']}", prompts_file)
            if rec["ratio_follow"] != "<image1>":
                raise SystemExit(f"{scene}_k{rec['k']}: ratio_follow {rec['ratio_follow']!r} — the node sizes the output to <image1> only")
    sheets = {} if dry else cc.sheet_embeddings()
    out_dir = episode_dir / "keyframes" / "images"
    out_dir.mkdir(parents=True, exist_ok=True)
    report, rows = {}, []
    for num, (scene, items) in enumerate(sorted(scenes.items()), start=1):
        if only and scene != only:
            continue
        prev: Path | None = None
        prev_px: float | None = None
        prev_order: tuple = ("barnaby", "ambrose")  # left person first: the storyboard puts Barnaby on the left
        for kf in items:
            k = kf["k"]
            if until is not None and k > until:
                print(f"STOP-GATE {scene}: generated up to K{until}. Review these keyframes (image-review-haiku skill) BEFORE continuing: every later keyframe is built on them. Rerun without --until (or with a larger one) to resume.", flush=True)
                break
            chosen = out_dir / f"{scene}_k{k}.png"
            if chosen.exists() and not redo and not dry:
                prev = chosen
                print(f"KEEP {chosen.name}", flush=True)
                big = [h for _x, h, _e in cc.faces_in(__import__("cv2").imread(str(chosen))) if h >= 35]
                prev_px = sum(big) / len(big) if big else None
                prev_order = _order_of(chosen, cc, sheets) or prev_order
                continue
            mode = kf["mode"]
            files = [prev if img == "@prev" else R / img for img in kf["images"]]
            if any(f is None for f in files):
                raise SystemExit(f"{scene}_k{k}: '@prev' but no keyframe was chosen before it")
            name = f"{scene}_k{k}"
            scored: list[tuple[float, float, str, tuple, Path]] = []
            for attempt in range(rounds):
                job = {"name": f"{name}_r{attempt}", "files": files,
                       "seeds": seeds_for(seed, n, num * 100 + k * 10 + attempt),
                       "graph": lambda names, sd, pr=kf["rewritten_prompt"]: compose_graph(pr, names, sd)}
                paths = run_jobs([job], out_dir / "candidates", dry)[0]
                rows.append(paths)
                if dry:
                    break
                scored += [(*_kf_score(pth, cc, sheets, prev_px, mode, prev_order), pth) for pth in paths]
                if scored and max(scored, key=lambda t: t[0])[0] >= 0.45:
                    break
            if dry:
                prev = chosen  # placeholder so the next keyframe's image list is the real one
                continue
            if not scored:
                raise SystemExit(f"{name}: every generation failed, stopping (the next keyframe is built on this one)")
            score, px, note, order, best = max(scored, key=lambda t: t[0])
            if score < 0.2:
                raise SystemExit(f"{name}: best candidate scores {score:.2f} ({note}, {best.name}) — stopping so no keyframe is built on it; look at the candidates and rewrite the prompt")
            chosen.write_bytes(best.read_bytes())
            prev, prev_px, prev_order = chosen, px or prev_px, order or prev_order
            report[name] = {"framing": kf["framing"], "mode": mode, "score": round(score, 3), "note": note, "candidate": best.name}
            print(f"CHOSEN {name} [{kf['framing']}/{mode}] score {score:.2f} ({note}) <- {best.name}", flush=True)
    if not dry:
        (out_dir / "keyframes_report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False) + "\n")
        flat = [[out_dir / f"{sc}_k{kf['k']}.png" for kf in its if (out_dir / f"{sc}_k{kf['k']}.png").exists()]
                for sc, its in sorted(scenes.items()) if not only or sc == only]
        contact_sheet([r for r in flat if r], out_dir / "contact_sheet.jpg", thumb_w=400)
        print(f"contact sheet at {out_dir / 'contact_sheet.jpg'}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("mode", choices=["keyframes"])
    p.add_argument("out", help="the episode directory (holds keyframes/qwen_keyframe_prompts.json)")
    p.add_argument("--n", type=int, default=3)
    p.add_argument("--seed", type=int, default=2000)
    p.add_argument("--only", help="a single scene key of the prompts file (chain_01, ...)")
    p.add_argument("--until", type=int, default=None, help="stop each chain after this keyframe index (e.g. 0 = only K0) so it can be reviewed before the rest is built on it")
    p.add_argument("--rounds", type=int, default=3, help="max rounds of --n candidates per keyframe")
    p.add_argument("--redo", action="store_true", help="regenerate keyframes that were already chosen")
    p.add_argument("--dry-run", action="store_true", help="gate the prompts and build graphs; no ComfyUI call")
    o = p.parse_args()
    cmd_keyframes(Path(o.out), o.n, o.seed, o.only, o.dry_run, o.redo, o.rounds, o.until)


if __name__ == "__main__":
    main()
