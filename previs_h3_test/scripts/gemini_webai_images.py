# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx", "pillow"]
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

Env: WEBAI_BASE_URL (default http://127.0.0.1:6969/v1), WEBAI_IMAGE_MODEL (default gemini-flash — one of the model
ids WebAI-to-API itself advertises at /v1/models; deliberately NOT named GEMINI_WEBAI_MODEL, since the app's .env
variable of that name is the NewAPI channel alias "gemini6969", which WebAI-to-API does not recognize directly),
GEMINI_WEBAI_COOKIE_FILE_HOST (default matches .env's GEMINI_WEBAI_COOKIE_FILE_HOST, the host path to
WebAI-to-API's runtime/auth/gemini.json), GEMINI_WEBAI_TIMEOUT_SECONDS (180).

All candidates within one run of this script (all -n candidates of one key, or every shot of one chain in
`storyboard`) share one WebAI conversation_id so Gemini keeps the character/lighting consistent across them, loaded
from and saved back to <out_dir>/session.json (or <gravity_test_dir>/storyboard/session.json) so a second run can
continue the same conversation.
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
MODEL = os.environ.get("WEBAI_IMAGE_MODEL") or "gemini-flash"
COOKIE_FILE = Path(os.environ.get("GEMINI_WEBAI_COOKIE_FILE_HOST", str(R / "../WebAI-to-API/runtime/auth/gemini.json")))
TIMEOUT = float(os.environ.get("GEMINI_WEBAI_TIMEOUT_SECONDS", "180"))
TARGET_SIZE = (1344, 768)  # matches dims_for_multishot("16:9") in runpod_minimax_h3_multishot_video.py


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


def fit_16x9(data: bytes) -> bytes:
    """Center-crop to 16:9 then resize to TARGET_SIZE — WebAI has no aspect_ratio param, so this is the only way
    to land on exactly the 1344x768 H3 expects (width/height must both be multiples of 32)."""
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
        path.write_bytes(fit_16x9(image_bytes))
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
    contact_sheet(rows, out_dir / "contact_sheet.jpg")
    print(f"wrote {sum(len(r) for r in rows)} candidates, contact sheet at {out_dir / 'contact_sheet.jpg'}")


def cmd_storyboard(gravity_dir: Path, n: int) -> None:
    out_dir = gravity_dir / "storyboard"
    session_file = out_dir / "session.json"
    conversation_id = load_session(session_file)
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
            for shot_idx, prompt in enumerate(chain["storyboard_prompts"], start=1):
                name = f"chain_{chain_num}_shot{shot_idx}"
                paths, conversation_id = _generate_candidates(client, prompt, refs, n, conversation_id, out_dir / "candidates", name, timing)
                rows.append(paths)
    save_session(session_file, conversation_id)
    (out_dir / "timing.json").write_text(json.dumps(timing, indent=1) + "\n")
    contact_sheet(rows, out_dir / "contact_sheet.jpg")
    print(f"wrote {sum(len(r) for r in rows)} candidates, contact sheet at {out_dir / 'contact_sheet.jpg'}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("mode", choices=["sheet", "plate", "storyboard"])
    p.add_argument("target")
    p.add_argument("arg", nargs="?")
    p.add_argument("--n", type=int, default=3)
    a = p.parse_args()
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
