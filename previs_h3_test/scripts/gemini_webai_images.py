# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx", "pillow", "opencv-python-headless", "numpy"]
# ///
"""Character sheets, empty plates, and in-scene storyboard frames through a local Gemini WebAI bridge (not Qwen).

  uv run previs_h3_test/scripts/gemini_webai_images.py sheet <out_dir> <image_prompts.json> [--n 3]
  uv run previs_h3_test/scripts/gemini_webai_images.py plate <out_dir> <image_prompts.json> [--n 3]
  uv run previs_h3_test/scripts/gemini_webai_images.py storyboard <gravity_test_dir> [--n 2]

`sheet`/`plate` read the `sheets`/`backgrounds` dict in <image_prompts.json> (one prompt per key) and write
<out_dir>/candidates/<key>_sK.png. `storyboard` reads every `chain_NN.json` (not `_refs_only`/`_single`/`_sb`) in
<gravity_test_dir>, sends its `storyboard_prompts[i]` with 3 references (the plate at `start_image`, then the two
sheets in `reference_images`), and writes <gravity_test_dir>/storyboard/candidates/chain_NN_shotM_sK.png. Every mode
also writes a contact_sheet.jpg and a timing.json next to its candidates.

Runs entirely on this machine against WebAI-to-API (http://127.0.0.1:6969 by default) — no GPU, no RunPod. This is
the same bridge `src/novelvideo/generators/nanobanana_grid.py` uses in the app (`_call_webai_chat_image_api`,
`_download_webai_artifact`, `_webai_ref_filename`); the request/response shape below is copied from there rather
than imported, so this script has no dependency on `novelvideo.*` and can run standalone on the local machine.

Env: WEBAI_BASE_URL (default http://127.0.0.1:6969/v1), WEBAI_IMAGE_MODEL (default gemini-auto — one of the model
ids WebAI-to-API itself advertises at /v1/models; this list is dynamic and has been observed to change across
restarts — e.g. gemini-flash/gemini-pro/gemini-thinking one run, just gemini-auto the next — so re-check
`curl 127.0.0.1:6969/v1/models` if a run fails with "Unknown model name". Deliberately NOT named GEMINI_WEBAI_MODEL,
since the app's .env variable of that name is the NewAPI channel alias "gemini6969", which WebAI-to-API does not
recognize directly),
GEMINI_WEBAI_COOKIE_FILE_HOST (default matches .env's GEMINI_WEBAI_COOKIE_FILE_HOST, the host path to
WebAI-to-API's runtime/auth/gemini.json), GEMINI_WEBAI_TIMEOUT_SECONDS (180).

All candidates within one run of this script (all -n candidates of one key, or every shot of one chain in
`storyboard`) share one WebAI conversation_id so Gemini keeps the character/lighting consistent across them, loaded
from and saved back to <out_dir>/session.json (or <gravity_test_dir>/storyboard/session.json) so a second run can
continue the same conversation.

Every image Gemini returns carries a small, visible, semi-transparent white sparkle/diamond watermark — distinct
from SynthID (invisible, not touched by this script) — landing consistently in roughly the same screen position
across sheet/plate/storyboard/transition images alike (empirically confirmed 2026-11-09 across 14 real generations:
position varies only slightly, always within roughly x=1080-1310, y=500-730 of the final 1344x768 canvas). `fit_16x9`
calls `remove_watermark()` on every image for exactly this reason — template-match + inpaint, not a crop (cropping
would eat into Ambrose's body, which sits in the right third of frame per series-bible.md and can overlap this same
screen region). A low-confidence match leaves the image untouched and prints a warning rather than guessing wrong;
`clean <image.png> ...` re-runs this on images already saved to disk (no new Gemini call) for one-off cleanup.

  uv run previs_h3_test/scripts/gemini_webai_images.py clean <image.png> [<image.png> ...]
"""
import argparse
import base64
import http.cookiejar
import json
import mimetypes
import os
import time
import urllib.request
from pathlib import Path

import httpx

R = Path(__file__).resolve().parents[2]
BASE_URL = os.environ.get("WEBAI_BASE_URL", "http://127.0.0.1:6969/v1").rstrip("/")
MODEL = os.environ.get("WEBAI_IMAGE_MODEL") or "gemini-auto"
COOKIE_FILE = Path(os.environ.get("GEMINI_WEBAI_COOKIE_FILE_HOST", str(R / "../WebAI-to-API/runtime/auth/gemini.json")))
TIMEOUT = float(os.environ.get("GEMINI_WEBAI_TIMEOUT_SECONDS", "180"))
TARGET_SIZE = (1344, 768)  # matches dims_for_multishot("16:9") in runpod_minimax_h3_multishot_video.py

# Gemini's visible sparkle watermark (see module docstring). Template cropped from barnaby_sheet.png, the clearest
# isolated sample (plain grey studio background). Tuned empirically against 14 real generations (sheets, plates,
# all 8 storyboard shots, the wormhole transition image, a plain test image) — see
# previs_h3_test/science_humor_gravity_test_run.md's 2026-11-09 watermark entry for the full data and what was
# tried and discarded:
# - The watermark lands at a near-FIXED absolute position on the final 1344x768 canvas regardless of image
#   content (confirmed by independently hand-measuring it in 6+ unrelated images, all landing within ~15px of
#   WATERMARK_CENTER) — this is a UI overlay, not content-aware placement, and `remove_watermark` always runs
#   post-crop/resize (inside `fit_16x9`) so the canvas is always normalized first. Detection is therefore anchored
#   to a small window around that known centre, NOT a free search of the whole image: an earlier free full-image
#   search (even restricted to the template's own scale) found confident-looking but WRONG matches on organic
#   texture (grass, lunar regolith) elsewhere in frame, since a soft radial blob is generic enough to coincidentally
#   match natural photo noise — anchoring the window removes that failure mode.
# - On the Moon-themed images specifically (moon.png, every chain_02 storyboard shot, the wormhole transition),
#   grayscale template matching scores POORLY even AT the hand-confirmed exact watermark location (score ~-0.3) —
#   lunar regolith's own fine speckled texture swamps the weak semi-transparent overlay's correlation signal. This
#   is a real, known limitation, not a bug to chase further: those images fall through to the "low confidence,
#   leave unchanged" path and need a human to check them (see verification steps in the plan this was built from).
# - Removal uses a shape-fitted inpaint mask (just the icon's bright core, dilated slightly — not a filled
#   rectangle) with a small inpaint radius: a full rectangular mask let `cv2.inpaint` bleed in nearby strongly-
#   coloured content (bled Barnaby's trouser leg into the hole on barnaby_sheet.png in testing) and, with a larger
#   radius, created a visible cross-hatch artifact in holes over fine repetitive texture (lunar regolith). An
#   algebraic "unscreen" correction (compute the overlay's per-pixel alpha from the template, solve for the
#   underlying pixel) was also tried and is cleaner in principle, but proved too sensitive to sub-pixel
#   match-to-reality misalignment, consistently leaving a faint residual ghost of the icon's own shape.
WATERMARK_TEMPLATE = Path(__file__).resolve().parent / "gemini_watermark_template.png"
WATERMARK_CENTER = (1240, 650)  # (x, y) on a 1344x768 canvas
WATERMARK_WINDOW = (90, 90)  # half-extent of the search box around WATERMARK_CENTER
WATERMARK_SCALES = tuple(round(0.85 + 0.02 * i, 2) for i in range(16))  # 0.85..1.15 step 0.02
WATERMARK_SCORE_MIN = 0.45
WATERMARK_ALPHA_THRESHOLD = 0.04  # template pixels lighter than this fraction above background count as "icon"
WATERMARK_MASK_DILATE = 9  # px, grows the shape mask past the alpha threshold to cover soft edge falloff
WATERMARK_INPAINT_RADIUS = 4


def _ref_filename(index: int, mime: str) -> str:
    """Extension must match the declared MIME or WebAI-to-API returns HTTP 400 (nanobanana_grid.py:_webai_ref_filename)."""
    ext = mimetypes.guess_extension(mime or "") or ".png"
    return f"ref_{index}{ext}"


def _mime_of(path: Path) -> str:
    return mimetypes.guess_type(path.name)[0] or "image/png"


def _download_artifact(url: str, cookie_file: Path) -> tuple[bytes | None, str]:
    """Same trick as nanobanana_grid.py:_download_webai_artifact: the artifact URL is a private googleusercontent
    link gated by the same Google session WebAI-to-API's browser is logged into; `=s0` asks for full resolution."""
    raw = json.loads(cookie_file.expanduser().read_text())
    jar = http.cookiejar.CookieJar()
    for cookie in raw.get("cookies", []):
        expires = cookie.get("expires", -1)
        jar.set_cookie(
            http.cookiejar.Cookie(
                0, cookie["name"], cookie["value"], None, False, cookie["domain"], True,
                cookie["domain"].startswith("."), cookie.get("path", "/"), True, bool(cookie.get("secure")),
                None if expires is None or expires <= 0 else int(expires), False, None, None, {},
            )
        )
    last_segment = url.rsplit("/", 1)[-1]
    full_res_url = url.split("=")[0] + "=s0" if "=s" not in last_segment else url
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    try:
        with opener.open(urllib.request.Request(full_res_url, headers={"User-Agent": "Mozilla/5.0"}), timeout=180) as resp:
            data = resp.read()
    except Exception as exc:  # noqa: BLE001
        return None, f"failed to download webai image artifact: {exc}"
    if not data.startswith((b"\x89PNG", b"\xff\xd8")):
        return None, "downloaded artifact is not a valid image (cookie expired? re-run verify_login.py on the host)"
    return data, ""


def generate(client: httpx.Client, prompt: str, refs: list[tuple[str, bytes, str]], conversation_id: str | None) -> tuple[bytes | None, str, str | None]:
    """One WebAI chat-completions call. Returns (image_bytes_or_None, error, conversation_id)."""
    content: list[dict] = [{"type": "text", "text": prompt}]
    for name, data, mime in refs:
        content.append({"type": "file", "file": {"filename": name, "file_data": f"data:{mime};base64,{base64.b64encode(data).decode()}"}})
    payload = {"model": MODEL, "messages": [{"role": "user", "content": content}]}
    if conversation_id:
        payload["conversation_id"] = conversation_id
    r = client.post(f"{BASE_URL}/chat/completions", json=payload, timeout=TIMEOUT)
    if r.status_code >= 400:
        return None, f"webai chat HTTP {r.status_code}: {r.text[:500]}", conversation_id
    data = r.json()
    conversation_id = data.get("conversation_id") or conversation_id
    choices = data.get("choices") or []
    artifacts = (choices[0] if choices else {}).get("artifacts") or []
    image_url = next((a.get("url") for a in artifacts if a.get("type") == "image" and a.get("url")), None)
    if not image_url:
        text = ((choices[0] if choices else {}).get("message") or {}).get("content") or ""
        return None, f"no image artifact in response (model said: {text[:200]!r})", conversation_id
    image_bytes, err = _download_artifact(image_url, COOKIE_FILE)
    return image_bytes, err, conversation_id


def _watermark_shape_mask(template_gray) -> "np.ndarray":
    """The icon's own silhouette (not its bounding rectangle): template pixels raised WATERMARK_ALPHA_THRESHOLD
    above the template's own background level, dilated a little to cover the soft edge falloff. A shape mask (not a
    filled rectangle) keeps the inpainted hole small, which matters twice over — it avoids pulling in nearby
    strongly-coloured content (a filled rectangle bled a character's trouser leg into the hole in testing) and
    avoids the cross-hatch artifact `cv2.inpaint` produces on a large hole over fine repetitive texture."""
    import cv2
    import numpy as np

    corner = np.concatenate([
        template_gray[:15, :15].ravel(), template_gray[:15, -15:].ravel(),
        template_gray[-15:, :15].ravel(), template_gray[-15:, -15:].ravel(),
    ]).astype(np.float32)
    bg_level = float(np.median(corner))
    alpha = (template_gray.astype(np.float32) - bg_level) / (255.0 - bg_level)
    mask = (alpha > WATERMARK_ALPHA_THRESHOLD).astype(np.uint8) * 255
    return cv2.dilate(mask, np.ones((WATERMARK_MASK_DILATE, WATERMARK_MASK_DILATE), np.uint8))


def remove_watermark(im: "Image.Image", label: str = "") -> "Image.Image":
    """Find and inpaint Gemini's visible sparkle watermark (see the WATERMARK_* constants' block comment for the
    empirical reasoning). Detection is anchored to a small window around WATERMARK_CENTER rather than searching the
    whole image, and only a narrow scale band close to the template's own captured size. Below
    WATERMARK_SCORE_MIN, leaves `im` untouched and prints a warning instead of guessing — this reliably happens for
    Moon-themed images (see the block comment), where a human should check the result by eye."""
    import cv2
    import numpy as np
    from PIL import Image

    if not WATERMARK_TEMPLATE.exists():
        print(f"remove_watermark: template missing at {WATERMARK_TEMPLATE}, skipping")
        return im
    template_gray = cv2.cvtColor(cv2.imread(str(WATERMARK_TEMPLATE)), cv2.COLOR_BGR2GRAY)
    th, tw = template_gray.shape
    shape_mask_template = _watermark_shape_mask(template_gray)

    arr = cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)
    h, w = arr.shape[:2]
    cx, cy = WATERMARK_CENTER
    wx, wy = WATERMARK_WINDOW
    rx0, ry0 = max(0, cx - wx), max(0, cy - wy)
    rx1, ry1 = min(w, cx + wx), min(h, cy + wy)
    region_gray = cv2.cvtColor(arr[ry0:ry1, rx0:rx1], cv2.COLOR_BGR2GRAY)

    best = (-1.0, None, None)
    for scale in WATERMARK_SCALES:
        tw_s, th_s = round(tw * scale), round(th * scale)
        if tw_s > region_gray.shape[1] or th_s > region_gray.shape[0] or tw_s < 4 or th_s < 4:
            continue
        tmpl_s = cv2.resize(template_gray, (tw_s, th_s))
        res = cv2.matchTemplate(region_gray, tmpl_s, cv2.TM_CCOEFF_NORMED)
        _, maxval, _, maxloc = cv2.minMaxLoc(res)
        if maxval > best[0]:
            best = (maxval, maxloc, (tw_s, th_s))
    score, loc, size = best
    tag = f" ({label})" if label else ""
    if loc is None or score < WATERMARK_SCORE_MIN:
        print(f"remove_watermark: no confident match{tag} (best score {score:.2f} < {WATERMARK_SCORE_MIN}), leaving image as-is — check it by eye")
        return im

    bx0, by0 = rx0 + loc[0], ry0 + loc[1]
    bx1, by1 = bx0 + size[0], by0 + size[1]
    shape_mask = cv2.resize(shape_mask_template, size, interpolation=cv2.INTER_NEAREST)
    full_mask = np.zeros((h, w), dtype=np.uint8)
    full_mask[by0:by1, bx0:bx1] = shape_mask
    cleaned = cv2.inpaint(arr, full_mask, inpaintRadius=WATERMARK_INPAINT_RADIUS, flags=cv2.INPAINT_TELEA)
    print(f"remove_watermark: inpainted{tag} at ({bx0},{by0})-({bx1},{by1}), score {score:.2f}")
    return Image.fromarray(cv2.cvtColor(cleaned, cv2.COLOR_BGR2RGB))


def fit_16x9(data: bytes, label: str = "") -> bytes:
    """Center-crop to 16:9, resize to TARGET_SIZE, then remove Gemini's visible watermark (see
    `remove_watermark`) — WebAI has no aspect_ratio param, so the crop/resize is the only way to land on exactly
    the 1344x768 H3 expects (width/height must both be multiples of 32)."""
    import io

    from PIL import Image

    im = Image.open(io.BytesIO(data)).convert("RGB")
    w, h = im.size
    target_ratio = TARGET_SIZE[0] / TARGET_SIZE[1]
    if w / h > target_ratio:
        new_w = round(h * target_ratio)
        im = im.crop(((w - new_w) // 2, 0, (w - new_w) // 2 + new_w, h))
    else:
        new_h = round(w / target_ratio)
        im = im.crop((0, (h - new_h) // 2, w, (h - new_h) // 2 + new_h))
    im = im.resize(TARGET_SIZE, Image.LANCZOS)
    im = remove_watermark(im, label)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def contact_sheet(rows: list[list[Path]], out: Path, thumb_w: int = 240) -> None:
    from PIL import Image

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


def load_session(path: Path) -> str | None:
    if path.exists():
        return json.loads(path.read_text()).get("conversation_id")
    return None


def save_session(path: Path, conversation_id: str | None) -> None:
    if conversation_id:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"conversation_id": conversation_id}, indent=1) + "\n")


def _generate_candidates(client: httpx.Client, prompt: str, refs: list[tuple[str, bytes, str]], n: int, conversation_id: str | None,
                          dest: Path, name: str, timing: list[dict]) -> tuple[list[Path], str | None]:
    dest.mkdir(parents=True, exist_ok=True)
    paths = []
    for k in range(1, n + 1):
        t0 = time.time()
        image_bytes, err, conversation_id = generate(client, prompt, refs, conversation_id)
        if image_bytes is None:
            print(f"{name}_s{k}: FAILED — {err}", flush=True)
            continue
        path = dest / f"{name}_s{k}.png"
        path.write_bytes(fit_16x9(image_bytes, label=f"{name}_s{k}"))
        secs = round(time.time() - t0, 1)
        timing.append({"name": name, "candidate": k, "seconds": secs, "conversation_id": conversation_id})
        print(f"{path.name}  {secs}s", flush=True)
        paths.append(path)
    return paths, conversation_id


def cmd_sheet_or_plate(mode: str, out_dir: Path, prompts_file: Path, n: int) -> None:
    prompts = json.loads(prompts_file.read_text())[{"sheet": "sheets", "plate": "backgrounds"}[mode]]
    session_file = out_dir / "session.json"
    conversation_id = load_session(session_file)
    timing: list[dict] = []
    rows = []
    with httpx.Client() as client:
        for name, entry in prompts.items():
            # A plain string entry (e.g. every `backgrounds` entry) has no identity reference; a dict entry (e.g.
            # a `sheets` entry with a real-photo reference, see SHEET_REFS in gen_chains.py) does.
            prompt, ref_path = (entry["prompt"], entry.get("ref")) if isinstance(entry, dict) else (entry, None)
            refs = []
            if ref_path:
                p = R / ref_path
                refs = [(_ref_filename(0, _mime_of(p)), p.read_bytes(), _mime_of(p))]
            paths, conversation_id = _generate_candidates(client, prompt, refs, n, conversation_id, out_dir / "candidates", name, timing)
            rows.append(paths)
    save_session(session_file, conversation_id)
    (out_dir / "timing.json").write_text(json.dumps(timing, indent=1) + "\n")
    _report_candidates(rows, out_dir)


def _report_candidates(rows: list[list[Path]], out_dir: Path) -> None:
    total = sum(len(r) for r in rows)
    if total:
        contact_sheet(rows, out_dir / "contact_sheet.jpg")
        print(f"wrote {total} candidates, contact sheet at {out_dir / 'contact_sheet.jpg'}")
    else:
        print("wrote 0 candidates — every generation failed above (e.g. a daily quota message); no contact sheet written")


def cmd_storyboard(gravity_dir: Path, n: int) -> None:
    """2026-11-09: one conversation_id PER CHAIN (per scene), not one shared across every chain — a shared
    conversation was found to bleed background figures between unrelated scenes (Eden's Adam/Eve turned up, bare
    and unsuited, standing on the Moon in one chain_02 shot) and to make a scene's own background figure
    inconsistent shot to shot (the Moon's lone astronaut: absent in one shot, oddly duplicated into a pair in
    another). Each chain's own 4 shots still share ONE conversation (keeps that chain's own continuity benefit),
    stored per chain_NN key in session.json so a second run can resume each chain's conversation independently."""
    out_dir = gravity_dir / "storyboard"
    session_file = out_dir / "session.json"
    sessions: dict[str, str] = json.loads(session_file.read_text()) if session_file.exists() else {}
    timing: list[dict] = []
    rows = []
    with httpx.Client() as client:
        for chain_file in sorted(gravity_dir.glob("chain_[0-9][0-9].json")):
            chain = json.loads(chain_file.read_text())
            if "storyboard_prompts" not in chain:
                print(f"skip {chain_file.name}: no storyboard_prompts (regenerate with gen_chains.py)")
                continue
            plate_path = R / chain["start_image"]
            sheet_paths = [R / p for p in chain["reference_images"]]
            refs = []
            for idx, p in enumerate([plate_path, *sheet_paths]):
                mime = _mime_of(p)
                refs.append((_ref_filename(idx, mime), p.read_bytes(), mime))
            chain_num = chain_file.stem.split("_")[1]
            chain_key = f"chain_{chain_num}"
            conversation_id = sessions.get(chain_key)
            for shot_idx, prompt in enumerate(chain["storyboard_prompts"], start=1):
                name = f"chain_{chain_num}_shot{shot_idx}"
                paths, conversation_id = _generate_candidates(client, prompt, refs, n, conversation_id, out_dir / "candidates", name, timing)
                rows.append(paths)
            if conversation_id:
                sessions[chain_key] = conversation_id
    session_file.parent.mkdir(parents=True, exist_ok=True)
    session_file.write_text(json.dumps(sessions, indent=1) + "\n")
    (out_dir / "timing.json").write_text(json.dumps(timing, indent=1) + "\n")
    _report_candidates(rows, out_dir)


def cmd_clean(image_paths: list[Path]) -> None:
    """Re-run `remove_watermark()` on images already saved to disk — no Gemini call, no cookie needed. Overwrites
    each file in place, so run it on a copy first if that matters. For images saved before this feature existed
    (e.g. the already-"chosen" sheet/plate/transition PNGs, which never go through a fresh `fit_16x9()` call)."""
    from PIL import Image

    for p in image_paths:
        if not p.exists():
            print(f"clean: {p} not found, skipping")
            continue
        im = Image.open(p).convert("RGB")
        im = remove_watermark(im, label=p.name)
        im.save(p, "PNG")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("mode", choices=["sheet", "plate", "storyboard", "clean"])
    p.add_argument("target")
    p.add_argument("arg", nargs="?")
    p.add_argument("more", nargs="*", help="clean mode only: additional image paths beyond <target>")
    p.add_argument("--n", type=int, default=3)
    a = p.parse_args()
    if a.mode == "clean":
        cmd_clean([Path(a.target), *([Path(a.arg)] if a.arg else []), *(Path(x) for x in a.more)])
        return
    if not COOKIE_FILE.exists():
        raise SystemExit(f"GEMINI_WEBAI_COOKIE_FILE_HOST not found: {COOKIE_FILE} (run verify_login.py on the host)")
    if a.mode == "storyboard":
        cmd_storyboard(Path(a.target), a.n)
    else:
        if not a.arg:
            raise SystemExit(f"{a.mode} needs <out_dir> <image_prompts.json>")
        cmd_sheet_or_plate(a.mode, Path(a.target), Path(a.arg), a.n)


if __name__ == "__main__":
    main()
