#!/usr/bin/env bash
# Pod-side steps for the gravity test, run from /opt/dramaclaw (start them in tmux so a dropped SSH link does not kill them).
#   bash previs_h3_test/scripts/skits/science_humor/gravity_test/run_batch.sh images
#       Ambrose's voice, then 3 Qwen candidates each for the two character sheets and the two empty backgrounds.
#       Pick one candidate per image and copy it to its final name before the videos stage (see pick_images below).
#   bash previs_h3_test/scripts/skits/science_humor/gravity_test/run_batch.sh videos chain_01 chain_01_refs_only ...
#       H3 chains one after the other; a finished chain is skipped on a rerun.
# Writes /opt/bench/gravity_<stage>.done or .failed.
set -uo pipefail
cd /opt/dramaclaw
PY=/opt/venv/bin/python
S=previs_h3_test/scripts
D=$S/skits/science_humor
G=$D/gravity_test
export PYTHONPATH=/opt/dramaclaw/src
export PATH="$HOME/.local/bin:$PATH"
STAGE=${1:?stage: images or videos}; shift || true
LOG=/opt/bench/gravity_$STAGE.log
rm -f /opt/bench/gravity_$STAGE.done /opt/bench/gravity_$STAGE.failed
exec > >(tee -a "$LOG") 2>&1
fail() { echo "FAILED: $1"; touch /opt/bench/gravity_$STAGE.failed; exit 1; }
stamp() { echo "=== $1 $(date -u +%T)"; echo "$STAGE:$1,$(date -u +%FT%TZ)" >> /opt/bench/gravity_stages.csv; }

stamp comfy_wait
for _ in $(seq 1 90); do curl -sf 127.0.0.1:8188/system_stats >/dev/null && break; sleep 2; done
curl -sf 127.0.0.1:8188/system_stats >/dev/null || fail "ComfyUI is not answering"

if [ "$STAGE" = images ]; then
  stamp voice_ambrose
  if [ ! -f "$D/voice/ambrose.wav" ]; then
    mkdir -p "$D/voice/ambrose_design"
    timeout 1200 uv run $S/qwen_voice_design.py "$D/voice/ambrose_design" "$D/voice/ambrose_config.json" || fail "voice design"
    cp "$D/voice/ambrose_design/ambrose.wav" "$D/voice/ambrose.wav" || fail "ambrose.wav missing"
  fi
  stamp qwen_nodes
  curl -s 127.0.0.1:8188/object_info > /opt/bench/object_info.json
  for n in TextEncodeQwenImage21 QwenImage21Cache; do grep -q "\"$n\"" /opt/bench/object_info.json || fail "node $n missing"; done
  stamp qwen_images
  $PY $S/qwen21_character_local.py prompts $G/qwen_prompts.json $D --n 3 || fail "qwen images"
  touch /opt/bench/gravity_images.done; stamp done; exit 0
fi

# videos
for n in H3MultishotSampler H3ModelLoaderAny; do
  curl -s 127.0.0.1:8188/object_info | grep -q "\"$n\"" || fail "node $n missing"
done
for f in $D/voice/barnaby.wav $D/voice/ambrose.wav $D/character/barnaby_sheet.png $D/character/ambrose_sheet.png $G/backgrounds/orchard.png $G/backgrounds/moon.png; do
  test -s "$f" || fail "missing input $f (pick the images first)"
done
stamp free_vram
curl -s -X POST 127.0.0.1:8188/free -H 'Content-Type: application/json' -d '{"unload_models":true,"free_memory":true}' >/dev/null
for c in "$@"; do
  stamp "$c"
  ls previs_h3_test/runs/*science_humor_gravity_test_$c/video.mp4 >/dev/null 2>&1 && continue
  BENCH_SCRIPT_FILE="$G/$c.json" BENCH_NOTE="science humor gravity test $c, 16:9 ref2va turbo12 two voice_refs, Qwen sheets+backgrounds" \
    $PY $S/bench_multishot30_local.py "science_humor_gravity_test_$c" || fail "chain $c"
  ls previs_h3_test/runs/*science_humor_gravity_test_$c/video.mp4 >/dev/null 2>&1 || fail "chain $c made no video"
done
touch /opt/bench/gravity_videos.done; stamp done
