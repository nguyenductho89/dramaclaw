#!/usr/bin/env bash
# Add the extra benchmark artifacts to an existing run dir (idempotent): steps.json, quality.json, ffprobe, and the process-level
# ComfyUI log slice summary. Usage: postrun.sh <run_dir>
D=${1:?run_dir}; H=$(cd "$(dirname "$0")" && pwd)
[ -f "$D/comfy.log" ] && python3 "$H/parse_steps.py" "$D/comfy.log" "$D/steps.json"
[ -f "$D/video.mp4" ] && python3 "$H/video_quality.py" "$D/video.mp4" "$D/quality.json" >/dev/null
echo "postrun done: $(ls "$D" | tr '\n' ' ')"
