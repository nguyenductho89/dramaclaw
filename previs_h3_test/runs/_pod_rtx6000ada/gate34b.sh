cd /opt/dramaclaw
PY=/opt/venv/bin/python; D=previs_h3_test/scripts; K=$D/skits/who_has_it_worse.json; RUNS=previs_h3_test/runs
tm() { echo "[$(date -u +%T)] $*"; }
src() { ls -d $RUNS/*_$1 | tail -1; }
C0=$(src g2_direct768)/video.mp4; C1=$(src g3_src_s1)/video.mp4; C2=$(src g3_src_s2)/video.mp4
for n in 1 2; do
  eval C=\$C$n; tm "== clip $n"
  $PY $D/latent_refine_local.py upscale $C g3_lbh2k_c$n --target 2k --prompt-file $K --seam guide --note "gate3 LBH 2k clip$n"
  $PY $D/upscale_video_local.py $C g3_sv7b2k_c$n --target 2k --model 7b --segment 41 --overlap 8 --dit-chunk 17 --tile 640 --tile-overlap 64
done
tm GATE3_DONE
$PY $D/latent_refine_local.py upscale $C0 g4_4k_22 --target 4k --split --max-frames 22 --prompt-file $K --seam none --note "gate4 4k split 22f"
tm "gate4 124"
$PY $D/latent_refine_local.py upscale $C0 g4_4k_124 --target 4k --split --prompt-file $K --seam guide --timeout 1800 --note "gate4 4k split 124f"
tm ALL_DONE
