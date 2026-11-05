#!/usr/bin/env bash
# One-shot generation for the ep01 60-second test, on a pod. Stages stay idempotent: a rerun skips finished images and videos.
#   bash previs_h3_test/scripts/skits/science_humor/run_ep01_batch.sh
# Order: voice and voiceover (GPU is free), portraits, keyframes, 4 H3 chains, SeedVR2 on chain 01.
# Writes /opt/bench/ep01_batch.done on success, .failed otherwise.
set -uo pipefail
cd /opt/dramaclaw
PY=/opt/venv/bin/python
S=previs_h3_test/scripts
D=$S/skits/science_humor
LOG=/opt/bench/ep01_batch.log
STAGES=/opt/bench/ep01_stages.csv
export PYTHONPATH=/opt/dramaclaw/src
rm -f /opt/bench/ep01_batch.done /opt/bench/ep01_batch.failed
exec > >(tee -a "$LOG") 2>&1

stage() { echo "$1,$(date -u +%FT%TZ)" >> "$STAGES"; echo "=== $1 $(date -u +%T)"; }
fail() { echo "FAILED: $1"; touch /opt/bench/ep01_batch.failed; exit 1; }

export PATH="$HOME/.local/bin:$PATH"

stage voice_design
if [ ! -f "$D/voice/voice_ref.wav" ]; then
  timeout 1200 uv run $S/qwen_voice_design.py "$D/voice" "$D/voice/voices_config.json" || fail "voice design"
  cp "$D/voice/barnaby.wav" "$D/voice/voice_ref.wav"
fi
test -f "$D/voice/voice_ref.wav" || fail "voice_ref.wav missing"

stage voiceover
if [ ! -f "$D/voice/vo/threejs_toast.wav" ]; then
  $PY -c "import json;print(json.load(open('$D/voice/voices_config.json'))['text'])" > /opt/bench/voice_ref_text.txt
  timeout 1200 uv run $S/qwen_voice_clone.py "$D/voice/voice_ref.wav" /opt/bench/voice_ref_text.txt "$D/voice/vo_lines.json" "$D/voice/vo" \
    || echo "VOICEOVER FAILED: chains can still run, gate 3 stays open"
fi

stage comfy_wait
for _ in $(seq 1 90); do curl -sf 127.0.0.1:8188/system_stats >/dev/null && break; sleep 2; done
curl -sf 127.0.0.1:8188/system_stats >/dev/null || fail "ComfyUI is not answering"
curl -s 127.0.0.1:8188/object_info > /opt/bench/object_info.json
for n in TextEncodeQwenImage21 QwenImage21Cache SeedVR2Preprocess; do grep -q "\"$n\"" /opt/bench/object_info.json || fail "node $n missing"; done

stage portraits
if [ ! -f "$D/character/portrait_s0.png" ]; then
  $PY $S/qwen21_character_local.py portrait "$D/character/portrait_prompt.txt" "$D/character" --n 3 || fail "portraits"
fi

stage keyframes
if [ ! -f "$D/ep01/keyframes/chain_04.png" ]; then
  $PY $S/qwen21_character_local.py keyframes "$D/ep01" "$D/character/portrait_s0.png" || fail "keyframes"
fi

stage free_vram
curl -s -X POST 127.0.0.1:8188/free -H 'Content-Type: application/json' -d '{"unload_models":true,"free_memory":true}' >/dev/null

for c in 01 02 03 04; do
  stage "chain_$c"
  ls previs_h3_test/runs/*_science_humor_ep01_chain_$c/video.mp4 >/dev/null 2>&1 && continue
  BENCH_SCRIPT_FILE="$D/ep01/chain_$c.json" BENCH_NOTE="science humor ep01 chain $c, 16:9 ref2va turbo12 voice_ref" \
    $PY $S/bench_multishot30_local.py "science_humor_ep01_chain_$c" || fail "chain $c"
  ls previs_h3_test/runs/*_science_humor_ep01_chain_$c/video.mp4 >/dev/null 2>&1 || fail "chain $c made no video"
done

stage free_vram_2
curl -s -X POST 127.0.0.1:8188/free -H 'Content-Type: application/json' -d '{"unload_models":true,"free_memory":true}' >/dev/null

stage upscale_chain_01
SRC=$(ls previs_h3_test/runs/*_science_humor_ep01_chain_01/video.mp4 | tail -1)
ls previs_h3_test/runs/*_science_humor_ep01_upscale_1p5x/video.mp4 >/dev/null 2>&1 || \
  $PY $S/upscale_video_local.py "$SRC" science_humor_ep01_upscale_1p5x --target 2016x1152 --model 7b --dit-chunk 17 --tile 640 --tile-overlap 64 \
  || echo "UPSCALE FAILED: videos are still usable, compare with Lanczos only"

stage done
touch /opt/bench/ep01_batch.done
