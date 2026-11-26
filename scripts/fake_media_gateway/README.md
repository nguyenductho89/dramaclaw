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

Tests: `uv run pytest tests/test_fake_media_gateway.py` (stub ComfyUI, no GPU).
