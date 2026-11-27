# fake_media_gateway

Stand-in for the NewAPI gateway. dramaclaw sends every image and video request to `NEWAPI_BASE_URL`;
this server answers the same endpoints and renders with Qwen-Image 2.1 and MiniMax H3 (v16) on a ComfyUI server.
The graph code is ported from `ad-with-skills` (`tools/comfy_qwen.py`, `qwen_images.py`, `h3_workflow_graph.py`).

## Run

```
COMFY_URL=http://127.0.0.1:8188 uv run python -m scripts.fake_media_gateway --port 8790
```

dramaclaw side (env only):

```
NEWAPI_BASE_URL=http://127.0.0.1:8790
NEWAPI_API_KEY=fake            # must equal FAKE_GATEWAY_API_KEY if that is set
VIDEO_BACKEND=newapi_MiniMax-H3
```

Text calls (prompt composers and other agents) are forwarded when `FAKE_GATEWAY_TEXT_UPSTREAM_URL` and
`FAKE_GATEWAY_TEXT_UPSTREAM_KEY` are set. If that upstream is a direct provider rather than a real NewAPI gateway,
also set `FAKE_GATEWAY_TEXT_MODEL` to one of its model names: every `DC-*-LLM` alias is rewritten to it, so
dramaclaw needs no per-task `*_MODEL` variables. Other model names pass through unchanged. The one replacement
model also receives the vision aliases, so calls that send images need a model that accepts them.

Keep these test settings out of `.env`: put them in a gitignored `.env.fake` and start the API with it.
Variables already in the process environment win over `.env`.

```
uv run --env-file .env.fake novelvideo api --host 127.0.0.1 --port 8780
```

For H3 Shots, `.env.fake` also needs `MiniMax-H3` in `NEWAPI_VIDEO_MODELS`, plus a media relay the gateway can
reach (`MEDIA_RELAY_PROVIDER=s3` and the `S3_RELAY_*` variables for a local S3 stand-in).
`scripts/start-ce.sh` sources `.env` over the shell, so do not use it for this mode.

ComfyUI comes from a rented 4090/5090 pod: bring it up with `ad-with-skills/tools/pod/pod_up.sh HOST PORT "--workflow-v16 --with-qwen"`,
then `ssh -L 8188:127.0.0.1:8188 ...`. `GET /healthz` checks that ComfyUI answers.

## Contract

| Endpoint | Behaviour |
| --- | --- |
| `POST /images/generations`, `/images/edits` | Synchronous. Output is `data[0].b64_json`. Image 1 is a grey canvas of the requested ratio (`metadata.ratio` or `width`/`height`), so the output has that ratio; reference images (`image: [url]` or `images: [{image_url}]`) follow as image 2.. (at most 9). |
| `POST /video/generations` | Queued, one render at a time. `duration` 4-15 s (`auto` = 5). Needs 1-9 images (`image` + `metadata.reference_images`), up to 3 `metadata.reference_audios`. `last_frame_image` and `reference_videos` are rejected with 400. |
| `GET /video/generations/{id}` | `status` is `queued`, `in_progress`, `completed` or `failed`; `result_url` points at `/files/{id}.mp4`; `error` on failure. |

References must be http(s) or `data:` URLs. Local files go through dramaclaw's `MEDIA_RELAY_PROVIDER` first, as with the real gateway.
Output is written to `output/fake_media_gateway/` (gitignored). Qwen-Image 2.1 is research/evaluation only: test output only.

## GPU cost (Vast.ai)

The cost of a render batch is the Vast account credit before renting minus the credit after the instance is deleted, so boot time,
idle time and storage are included. It is split over the renders in proportion to their GPU time (`gpu_seconds`, wall time of each render)
and attributed to beats through `metadata.dc_context` (`project`, `episode`, `beat_num`), which dramaclaw sends for MiniMax-H3.
Recording only; nothing is charged. Needs `VAST_API_KEY` (or pass the balance by hand with `--credit-before` / `--credit-after`).

```
uv run python -m scripts.fake_media_gateway billing start    # 1. before renting the instance
# 2. rent the instance, run the gateway, render, fetch every video, delete the instance
uv run python -m scripts.fake_media_gateway billing close    # 3. after it is deleted: prints a per-beat cost table
uv run python -m scripts.fake_media_gateway billing report [SESSION_ID]
```

- Ledgers are JSON files in `output/fake_media_gateway_billing/` (outside `/files`, gitignored). One session is open at a time; renders finishing while none is open are not billed.
- A failed render is billed too: it held the GPU. `close` refuses a negative total (a top-up in between): restart the session with the balance after the top-up.
- `GET /billing/tasks/{id}` gives `gpu_seconds` straight away and `usd` once the session is closed; the task status carries `usage.gpu_seconds`.
- The `credit` field of `GET https://console.vast.ai/api/v0/users/current/` is the balance read.

Tests: `uv run pytest tests/test_fake_media_gateway.py` (stub ComfyUI, no GPU).
