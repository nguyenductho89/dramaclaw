#!/usr/bin/env bash
# Pod-side steps of one episode, run from /opt/dramaclaw (start them in tmux so a dropped SSH link does not kill them).
# The episode is picked with SERIES and EP (default science_humor and ep01).
#   bash video_production_with_skills/tools/pod/run_batch.sh voices
#       3 American candidates for Einstein and 3 British candidates for Newton, written to assets/voices/candidates/.
#       Pick one of each with tools/pick_voices.py (copies assets/voices/einstein.wav and newton.wav).
#   bash video_production_with_skills/tools/pod/run_batch.sh images --n 3 [--only chain_01] [--until 0]
#       Qwen-Image 2.1 keyframes on the pod (tools/qwen_images.py keyframes; needs pod_up.sh ... --images-only). Every
#       prompt must already be reviewed with the qwen-image-prompting skill and recorded by tools/qwen_prompt_gate.py.
#   bash video_production_with_skills/tools/pod/run_batch.sh videos chain_01 chain_02 ...
#       H3 chains one after the other (tools/render_chain.py); a finished chain is skipped on a rerun. A chain renders only
#       when its start_image (the keyframe K0) is approved in keyframes/approved.json (tools/approve_keyframes.py).
# Character sheets and empty backgrounds are made on the LOCAL machine by tools/gemini_webai_images.py. Qwen-Image 2.1 is
# research/evaluation-licensed only: use it for test output, not for a monetised release.
# Writes /opt/bench/<EP>_<stage>.done or .failed.
set -uo pipefail
cd /opt/dramaclaw
PY=/opt/venv/bin/python
SERIES=${SERIES:-science_humor}; EP=${EP:-ep01}
export SERIES EP
V=video_production_with_skills
T=$V/tools
SD=$V/series/$SERIES
ED=$SD/$EP
export PYTHONPATH=/opt/dramaclaw/src
export PATH="$HOME/.local/bin:$PATH"
STAGE=${1:?stage: voices, images or videos}; shift || true
LOG=/opt/bench/${EP}_$STAGE.log
rm -f /opt/bench/${EP}_$STAGE.done /opt/bench/${EP}_$STAGE.failed
exec > >(tee -a "$LOG") 2>&1
fail() { echo "FAILED: $1"; touch /opt/bench/${EP}_$STAGE.failed; exit 1; }
stamp() { echo "=== $1 $(date -u +%T)"; echo "$STAGE:$1,$(date -u +%FT%TZ)" >> /opt/bench/${EP}_stages.csv; }
free_vram() { curl -s -X POST 127.0.0.1:8188/free -H 'Content-Type: application/json' -d '{"unload_models":true,"free_memory":true}' >/dev/null; }

stamp comfy_wait
for _ in $(seq 1 90); do curl -sf 127.0.0.1:8188/system_stats >/dev/null && break; sleep 2; done
curl -sf 127.0.0.1:8188/system_stats >/dev/null || fail "ComfyUI is not answering"

if [ "$STAGE" = voices ]; then
  stamp free_vram; free_vram
  stamp voice_einstein_us
  timeout 1200 uv run $T/qwen_voice_design.py "$SD/assets/voices/candidates/einstein" "$SD/assets/voices/einstein_us_config.json" || fail "voice design einstein"
  stamp voice_newton_uk
  timeout 1200 uv run $T/qwen_voice_design.py "$SD/assets/voices/candidates/newton" "$SD/assets/voices/newton_candidates.json" || fail "voice design newton"
  touch /opt/bench/${EP}_voices.done; stamp done; exit 0
fi

if [ "$STAGE" = images ]; then
  for n in QwenImage21Cache TextEncodeQwenImage21; do
    curl -s 127.0.0.1:8188/object_info | grep -q "\"$n\"" || fail "node $n missing (pod_up.sh needs --images-only or --with-qwen)"
  done
  stamp free_vram; free_vram
  stamp qwen_keyframes
  timeout 3600 $PY $T/qwen_images.py keyframes "$ED" "$@" || fail "qwen_images keyframes"
  touch /opt/bench/${EP}_images.done; stamp done; exit 0
fi

# videos
for n in H3MultishotSampler H3ModelLoaderAny; do
  curl -s 127.0.0.1:8188/object_info | grep -q "\"$n\"" || fail "node $n missing"
done
for f in $SD/assets/voices/einstein.wav $SD/assets/voices/newton.wav $SD/assets/characters/einstein_sheet.png $SD/assets/characters/newton_sheet.png; do
  test -s "$f" || fail "missing input $f (make it first: tools/gemini_webai_images.py sheet, or run_batch.sh voices)"
done
stamp free_vram; free_vram
# Keyframe review gate: a chain whose start_image is a keyframe renders only if a human approved it
# (tools/approve_keyframes.py approve, after looking at the keyframes). KEYFRAME_GATE=0 skips it (not for real runs).
gate_ok() {
  [ "${KEYFRAME_GATE:-1}" = 0 ] && return 0
  local img; img=$($PY -c "import json,sys; print(json.load(open(sys.argv[1])).get('start_image') or '')" "$ED/chains/$1.json")
  case "$img" in */keyframes/images/*) $PY $T/approve_keyframes.py check "$img" ;; *) return 0 ;; esac
}
for c in "$@"; do
  test -s "$ED/chains/$c.json" || fail "no chain $ED/chains/$c.json"
  gate_ok "$c" || fail "keyframe of $c not approved (see tools/approve_keyframes.py) — no GPU time spent on unreviewed frames"
done
for c in "$@"; do
  stamp "$c"
  ls $V/runs/*_${SERIES}_${EP}_$c/video.mp4 >/dev/null 2>&1 && continue
  RENDER_NOTE="$SERIES $EP $c, 16:9 ref2va classic sampler, start_image K0, two voice_refs" \
    $PY $T/render_chain.py "$ED/chains/$c.json" "${SERIES}_${EP}_$c" || fail "chain $c"
  ls $V/runs/*_${SERIES}_${EP}_$c/video.mp4 >/dev/null 2>&1 || fail "chain $c made no video"
done
touch /opt/bench/${EP}_videos.done; stamp done
