# RunPod worker images

Sources of the three RunPod Serverless worker images (ComfyUI 0.37.2 + a small handler that
takes one job, runs it, uploads the outputs to R2). They used to live in the
`photoreal-short-drama-generator` repo; since 2026-10-31 this is where they are edited and built.

```
runpod/
  common/handler.py        # one shared handler (the three old copies were byte-identical)
  qwen/                    # Qwen-Image 2.1, Qwen-Image-Edit-2511, SeedVR2, SAM3, frame interpolation
  h3/                      # MiniMax H3 1-shot (ref2va / fl2va)
  multishot/               # MiniMax H3 multishot chain
```

Each image directory has a `Dockerfile`, a `start.sh` and an `extra_model_paths.yaml`. The build
context is `runpod/` itself, so a Dockerfile adds `<image>/start.sh` and `common/handler.py`.

| Image directory | GHCR image name | Endpoint |
|---|---|---|
| `qwen` | `photoreal-qwen-worker` | `q639jfhc6uaf3t` (`qwen-image-t2i-fast`) |
| `h3` | `photoreal-h3-worker` | `a31613hf7l83r5` (`h3-i2v-ref2va-fl2va`) |
| `multishot` | `comfy-trends-h3-multishot` | `u0hkrms7k1xeua` (`h3-multishot-i2v-fl2va-ref2va`) |

Endpoint settings, mounted files and history: `runpod-endpoints-checkpoints.md` and
`runpod-h3-qwen-endpoints.md` at the repository root.

## Build

CUDA images for amd64 cannot be built on an Apple-silicon laptop in reasonable time, so they are
built by GitHub Actions: **Actions -> Build and push RunPod worker image -> Run workflow**, pick
`image` (`qwen`, `h3` or `multishot`) and a `tag`. It pushes
`ghcr.io/<owner>/<image name>:<tag>` and needs a repository secret `GHCR_PAT` (a personal access
token with `write:packages`). Then set the new tag on the endpoint (workers only pick up a new
image as they cycle). A Dockerfile can be linted locally:

```bash
docker build --check -f runpod/qwen/Dockerfile runpod
```

## Model folders and LoRAs

All endpoints share the Network Volume `zyen2jmxt3`. `extra_model_paths.yaml` decides which
`/runpod-volume/models/<folder>` directories an image can see. The Qwen image also maps `loras/`
and `model_patches/` (Qwen-Image 2.1 Turbo LoRA, Fun-ControlNet-Union).

`start.sh` passes the endpoint env `COMFY_EXTRA_ARGS` to ComfyUI unquoted, e.g.
`--extra-model-paths-config /runpod-volume/extra_paths_loras.yaml` or `--use-sage-attention`.
Changing an endpoint's `env` replaces the whole set, so resend every variable (the R2 ones are
RunPod secret references).

## Not here

The script that fills the volume with models (`populate_volume.sh`) and the client side of the
photoreal pipeline (`scripts/rp.py`, its queue runner) still live in the
`photoreal-short-drama-generator` repo; they are tied to that project's configuration.
