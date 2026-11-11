#!/bin/bash
cd /opt/dramaclaw; export PYTHONPATH=/opt/dramaclaw/src; P=/opt/venv/bin/python; S=previs_h3_test/scripts
while pgrep -f "[l]atent_refine_local" >/dev/null; do sleep 10; done
BENCH_SCRIPT_FILE=previs_h3_test/scripts/skits/who_has_it_worse.json BENCH_NOTE="skit who_has_it_worse 3x243 PDD8 9:16, 4090 NVMe 120G" $P $S/bench_multishot30_local.py skit_who_has_it_worse > /opt/skit_gen.out 2>&1
V=$(ls -dt previs_h3_test/runs/*_skit_who_has_it_worse | head -1)/video.mp4
$P $S/latent_refine_local.py upscale $V skit_lbh_1080_s07 --target 1080p --sigmas nvlabs2 --seam guide --segment 124 --note skit_refine > /opt/skit_refine.out 2>&1
echo done > /opt/chain_done
