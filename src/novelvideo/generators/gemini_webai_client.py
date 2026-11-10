# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Shared low-level helpers for the local Gemini WebAI bridge (WebAI-to-API, port 6969).

Extracted from `nanobanana_grid.py` so BOTH callers use one copy:

- the app (`nanobanana_grid.py`'s `_call_webai_chat_image_api`, which re-exports
  these two under their original private names);
- the standalone previs CLI `previs_h3_test/scripts/gemini_webai_images.py`,
  which had hand-copied both (its own docstring said so) and drifted.

Deliberately has **no top-level `novelvideo` import**: the previs script runs
under `uv run` with its own dependency set and loads this file by path with
`importlib.util.spec_from_file_location`, the same way
`previs_h3_test/scripts/qwen_images.py:_load_lint()` loads the Qwen prompt
linter. Keep it that way — `record_artifact` is imported lazily and its absence
is not an error.
"""

from __future__ import annotations

import json
import mimetypes
from pathlib import Path

ARTIFACT_DOWNLOAD_TIMEOUT_SECONDS = 180


def download_webai_artifact(url: str, cookie_file: str) -> tuple[bytes | None, str]:
    """Download a Gemini WebAI-generated image using its Playwright session cookies.

    The artifact URL (from `/chat/completions` → `choices[].artifacts[].url`) is a
    private googleusercontent link gated by the same Google account session the
    WebAI server's browser is logged into — a bare request without those cookies
    gets HTTP 403. `=s0` requests the original resolution instead of Google's
    default 512px thumbnail (same trick as comfy-trends' gemini_client.py).
    """
    import http.cookiejar
    import urllib.request

    try:
        raw = json.loads(Path(cookie_file).expanduser().read_text())
    except OSError as exc:
        return None, f"cannot read GEMINI_WEBAI_COOKIE_FILE: {exc}"
    except ValueError as exc:
        return None, f"GEMINI_WEBAI_COOKIE_FILE is not valid JSON: {exc}"

    jar = http.cookiejar.CookieJar()
    for cookie in raw.get("cookies", []):
        expires = cookie.get("expires", -1)
        jar.set_cookie(
            http.cookiejar.Cookie(
                0,
                cookie["name"],
                cookie["value"],
                None,
                False,
                cookie["domain"],
                True,
                cookie["domain"].startswith("."),
                cookie.get("path", "/"),
                True,
                bool(cookie.get("secure")),
                None if expires is None or expires <= 0 else int(expires),
                False,
                None,
                None,
                {},
            )
        )

    last_segment = url.rsplit("/", 1)[-1]
    full_res_url = url.split("=")[0] + "=s0" if "=s" not in last_segment else url
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    try:
        with opener.open(
            urllib.request.Request(full_res_url, headers={"User-Agent": "Mozilla/5.0"}),
            timeout=ARTIFACT_DOWNLOAD_TIMEOUT_SECONDS,
        ) as resp:
            data = resp.read()
    except Exception as exc:
        return None, f"failed to download webai image artifact: {exc}"

    if not data.startswith((b"\x89PNG", b"\xff\xd8")):
        return None, "downloaded artifact is not a valid image (cookie expired?)"
    # Lazily imported and optional on purpose: the previs CLI loads this module by
    # path with no `novelvideo` package on sys.path, where the LLM call log does
    # not exist. Inside the app this import always succeeds, so the Langfuse
    # artifact record keeps firing exactly as it did before the extraction.
    try:
        from novelvideo.llm_call_log import record_artifact

        record_artifact("image", data=data, label="gemini_webai", source_url=url)
    except ImportError:
        pass
    return data, ""


def webai_ref_filename(index: int, mime: str) -> str:
    """Build a reference-image filename whose extension matches its MIME type.

    WebAI-to-API (port 6969) validates that the filename extension matches the
    declared MIME type and returns HTTP 400 ("File extension '.png' is not
    allowed for MIME type 'image/jpeg'") on a mismatch — so the extension must
    be derived from `mime`, never hardcoded.
    """
    ext = mimetypes.guess_extension(mime or "") or ".png"
    return f"ref_{index}{ext}"
