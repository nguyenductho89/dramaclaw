"""Character sheets, empty backgrounds and composed storyboard frames with Qwen-Image 2.1 on a LOCAL ComfyUI — the
Qwen counterpart of gemini_webai_images.py (same prompt files, same output folders), so it can run on the rented GPU
box with no Google login, cookie or browser.

  python previs_h3_test/scripts/qwen_images.py plate      <out_dir> [--n 3] [--only moon] [--dry-run]
  python previs_h3_test/scripts/qwen_images.py sheet      <out_dir> [--n 3] [--only barnaby] [--dry-run]
  python previs_h3_test/scripts/qwen_images.py storyboard <gravity_test_dir> [--n 2] [--only chain_02_shot3] [--dry-run]

plate / sheet: text-to-image from gravity_test/image_prompts.json (the same prompts Gemini uses), 1344x768.
  A sheet entry with a real-photo `ref` is made as an edit: a grey 1344x768 canvas is image_1 (it fixes the frame),
  the photo is image_2 — NOT yet checked on a GPU.
storyboard: reads `storyboard_prompts_qwen` from each chain_NN.json (gen_chains.py `storyboard_prompt_qwen`). image_1 =
  the chain's empty plate (the edit target), image_2/3 = the two sheets, in the order the prompt's <imageN> tags use.
Candidates go to <out_dir>/candidates/<name>_sK.png plus contact_sheet.jpg. Pick one per name, copy it to the final name,
then run check_chains.py --storyboard on it (identity) and the image-scale-review skill (scale) BEFORE any H3 render.
Stateless: every call is independent, so nothing leaks between scenes the way a shared Gemini conversation did.

Qwen-Image 2.1 is licensed for research and evaluation only: test output only, not for a monetised release.
"""
import argparse
import importlib.util
import io
import json
import sys
import time
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import qwen21_character_local as q  # noqa: E402  (ComfyUI helpers: loaders, sampler, upload, render)

R = HERE.parents[1]
MAX_IMAGES = 16
CANVAS_NAME = "qwen_images_grey_canvas.png"


def _load_lint():
    path = R / "src/novelvideo/agents/qwen21_compose_prompt_lint.py"
    spec = importlib.util.spec_from_file_location("qwen21_compose_prompt_lint", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.lint_qwen21_compose_prompt


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
    """Edits run at resolution 1536, then shrink to the frame size (see qwen21_character_local.py docstring)."""
    im = Image.open(io.BytesIO(data)).convert("RGB")
    if abs(im.width / im.height - q.WIDTH / q.HEIGHT) > 0.01:
        print(f"WARNING: output is {im.size}, not 16:9 — image_1 was not 16:9, so the resize below stretches it", flush=True)
    if im.size != (q.WIDTH, q.HEIGHT):
        im = im.resize((q.WIDTH, q.HEIGHT), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def grey_canvas() -> Path:
    path = Path("/tmp") / CANVAS_NAME
    Image.new("RGB", (q.WIDTH, q.HEIGHT), (128, 128, 128)).save(path)
    return path


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
    """job: name, graph(seed) -> graph, files (paths to upload, in image order, or []), seeds, prompt, n_images."""
    rows, timing = [], []
    lint = _load_lint()
    for job in jobs:
        paths = []
        if job["n_images"] >= 2:
            for issue in lint(job["prompt"], job["n_images"]):
                print(f"LINT {job['name']}: {issue}", flush=True)
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


def jobs_plate_or_sheet(mode: str, prompts_file: Path, n: int, seed: int, only: str | None) -> list[dict]:
    spec = json.loads(prompts_file.read_text())[{"sheet": "sheets", "plate": "backgrounds"}[mode]]
    jobs = []
    for salt, (name, entry) in enumerate(spec.items()):
        if only and name != only:
            continue
        prompt, ref = (entry["prompt"], entry.get("ref")) if isinstance(entry, dict) else (entry, None)
        if ref:
            prompt = ("<image1> is a blank grey canvas that sets the frame; <image2> is a reference photo of the real man whose likeness "
                      "the character sheet must match, his face, hair and age exactly as shown. " + prompt)
            files = [grey_canvas(), R / ref]
            graph = lambda names, s, p=prompt: compose_graph(p, names, s)  # noqa: E731
        else:
            files = []
            graph = lambda names, s, p=prompt: q.t2i_graph(p, s)  # noqa: E731
        jobs.append({"name": name, "prompt": prompt, "files": files, "n_images": len(files), "seeds": seeds_for(seed, n, salt), "graph": graph})
    return jobs


def jobs_storyboard(gravity_dir: Path, n: int, seed: int, only: str | None) -> list[dict]:
    jobs = []
    for chain_file in sorted(gravity_dir.glob("chain_[0-9][0-9].json")):
        chain = json.loads(chain_file.read_text())
        if "storyboard_prompts_qwen" not in chain:
            print(f"skip {chain_file.name}: no storyboard_prompts_qwen (rerun gen_chains.py)")
            continue
        num = chain_file.stem.split("_")[1]
        files = [R / chain["start_image"], *[R / p for p in chain["reference_images"]]]
        for shot_idx, prompt in enumerate(chain["storyboard_prompts_qwen"], start=1):
            name = f"chain_{num}_shot{shot_idx}"
            if only and name != only:
                continue
            jobs.append({"name": name, "prompt": prompt, "files": files, "n_images": len(files),
                         "seeds": seeds_for(seed, n, int(num) * 10 + shot_idx),
                         "graph": lambda names, s, p=prompt: compose_graph(p, names, s)})
    return jobs


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("mode", choices=["plate", "sheet", "storyboard"])
    p.add_argument("out", help="plate/sheet: output dir; storyboard: the gravity_test dir")
    p.add_argument("--n", type=int, default=3)
    p.add_argument("--seed", type=int, default=2000)
    p.add_argument("--only", help="a single name (moon, barnaby, chain_02_shot3, ...)")
    p.add_argument("--prompts", default=str(R / "previs_h3_test/scripts/skits/science_humor/gravity_test/image_prompts.json"))
    p.add_argument("--dry-run", action="store_true", help="build graphs and lint prompts; no ComfyUI call")
    o = p.parse_args()
    out = Path(o.out)
    if o.mode == "storyboard":
        jobs, dest = jobs_storyboard(out, o.n, o.seed, o.only), out / "storyboard" / "candidates"
    else:
        jobs, dest = jobs_plate_or_sheet(o.mode, Path(o.prompts), o.n, o.seed, o.only), out / "candidates"
    if not jobs:
        sys.exit("nothing to do (check --only and that gen_chains.py has been run)")
    rows = run_jobs(jobs, dest, o.dry_run)
    if not o.dry_run:
        total = sum(len(r) for r in rows)
        if total:
            contact_sheet(rows, dest.parent / "contact_sheet.jpg")
            print(f"wrote {total} candidates, contact sheet at {dest.parent / 'contact_sheet.jpg'}")
        else:
            print("wrote 0 candidates — every generation failed above")


if __name__ == "__main__":
    main()
