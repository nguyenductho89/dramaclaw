#!/usr/bin/env bash
# Pod-side steps for the gravity test, run from /opt/dramaclaw (start them in tmux so a dropped SSH link does not kill them).
#   bash previs_h3_test/scripts/skits/science_humor/gravity_test/run_batch.sh voices
#       3 American candidates for Barnaby and 3 British candidates for Ambrose.
#   bash previs_h3_test/scripts/skits/science_humor/gravity_test/run_batch.sh videos chain_01 chain_01_refs_only ...
#       H3 chains one after the other; a finished chain is skipped on a rerun.
# There is no `images` stage here any more: character sheets, empty backgrounds, and storyboard frames are now
# generated on the LOCAL machine by gemini_webai_images.py (not Qwen on the pod — Qwen-Image 2.1 is
# research/evaluation-licensed only and is no longer in this pipeline). Generate and pick those locally first, then
# upload them alongside the code (pod_up.sh's tar) before running this script's `videos` stage.
# Writes /opt/bench/gravity_<stage>.done or .failed.
set -uo pipefail
cd /opt/dramaclaw
PY=/opt/venv/bin/python
S=previs_h3_test/scripts
D=$S/skits/science_humor
G=$D/gravity_test
export PYTHONPATH=/opt/dramaclaw/src
export PATH="$HOME/.local/bin:$PATH"
STAGE=${1:?stage: voices or videos}; shift || true
LOG=/opt/bench/gravity_$STAGE.log
rm -f /opt/bench/gravity_$STAGE.done /opt/bench/gravity_$STAGE.failed
exec > >(tee -a "$LOG") 2>&1
fail() { echo "FAILED: $1"; touch /opt/bench/gravity_$STAGE.failed; exit 1; }
stamp() { echo "=== $1 $(date -u +%T)"; echo "$STAGE:$1,$(date -u +%FT%TZ)" >> /opt/bench/gravity_stages.csv; }

stamp comfy_wait
for _ in $(seq 1 90); do curl -sf 127.0.0.1:8188/system_stats >/dev/null && break; sleep 2; done
curl -sf 127.0.0.1:8188/system_stats >/dev/null || fail "ComfyUI is not answering"

if [ "$STAGE" = voices ]; then
  # Candidate voices: American for Barnaby, British for Ambrose. Pick one of each (lowest cosine between them), copy to voice/barnaby.wav and voice/ambrose.wav.
  stamp free_vram
  curl -s -X POST 127.0.0.1:8188/free -H 'Content-Type: application/json' -d '{"unload_models":true,"free_memory":true}' >/dev/null
  stamp voice_barnaby_us
  timeout 1200 uv run $S/qwen_voice_design.py "$D/voice/barnaby_us_cands" "$D/voice/barnaby_us_config.json" || fail "voice design barnaby"
  stamp voice_ambrose_uk
  timeout 1200 uv run $S/qwen_voice_design.py "$D/voice/ambrose_cands" "$D/voice/ambrose_candidates.json" || fail "voice design ambrose"
  touch /opt/bench/gravity_voices.done; stamp done; exit 0
fi

# videos
for n in H3MultishotSampler H3ModelLoaderAny; do
  curl -s 127.0.0.1:8188/object_info | grep -q "\"$n\"" || fail "node $n missing"
done
for f in $D/voice/barnaby.wav $D/voice/ambrose.wav $D/character/barnaby_sheet.png $D/character/ambrose_sheet.png \
         $D/character/barnaby_front.png $D/character/ambrose_front.png $G/backgrounds/orchard.png $G/backgrounds/moon.png; do
  test -s "$f" || fail "missing input $f (generate and pick it locally with gemini_webai_images.py first)"
done
stamp free_vram
curl -s -X POST 127.0.0.1:8188/free -H 'Content-Type: application/json' -d '{"unload_models":true,"free_memory":true}' >/dev/null
for c in "$@"; do
  stamp "$c"
  ls previs_h3_test/runs/*science_humor_gravity_test_$c/video.mp4 >/dev/null 2>&1 && continue
  BENCH_SCRIPT_FILE="$G/$c.json" BENCH_NOTE="science humor gravity test $c, 16:9 ref2va turbo12 two voice_refs, Gemini WebAI sheets+backgrounds/storyboard" \
    $PY $S/bench_multishot30_local.py "science_humor_gravity_test_$c" || fail "chain $c"
  ls previs_h3_test/runs/*science_humor_gravity_test_$c/video.mp4 >/dev/null 2>&1 || fail "chain $c made no video"
done
touch /opt/bench/gravity_videos.done; stamp done
