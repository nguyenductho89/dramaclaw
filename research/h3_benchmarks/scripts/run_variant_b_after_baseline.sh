#!/bin/sh
# Wait for baseline (scripts/pipeline.py) to finish, then run variant B.
cd /home/user/dramaclaw
while pgrep -f "^[^ ]*python[^ ]* [^ ]*scripts/pipeline[.]py" >/dev/null; do sleep 10; done
echo "$(date -u +%H:%M:%S) [video_ref] baseline finished, starting variant B" >> research/h3_benchmarks/pipeline.log
PYTHONPATH=src RUNPOD_H3_PDD_REF2VA= \
RUNPOD_H3_TURBO_LORA_REF2VA=minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors \
RUNPOD_H3_TURBO_STEPS_REF2VA=6 \
.venv/bin/python research/h3_benchmarks/scripts/pipeline_video_ref.py > research/h3_benchmarks/pipeline_video_ref.out 2>&1
