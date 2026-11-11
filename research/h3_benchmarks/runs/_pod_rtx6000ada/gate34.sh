cd /opt/dramaclaw
PY=/opt/venv/bin/python; D=previs_h3_test/scripts; K=$D/skits/who_has_it_worse.json
RUNS=previs_h3_test/runs
tm() { echo "[$(date -u +%T)] $*"; }
tm "download seedvr2"
( aria2c -c -x16 -s16 -k4M --dir=/opt/models/diffusion_models -o seedvr2_7b_int8_convrot.safetensors https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_7b_int8_convrot.safetensors
  aria2c -c -x16 -s16 -k4M --dir=/opt/models/vae -o seedvr2_ema_vae_fp16.safetensors https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/vae/seedvr2_ema_vae_fp16.safetensors ) > /opt/dl_seedvr2.log 2>&1 &
DL=$!
tm "gen clips shot1 shot2"
$PY $D/latent_refine_local.py direct g3_src_s1 --target 768p --prompt-file $K --shot 1 --note "gate3 source clip shot1"
$PY $D/latent_refine_local.py direct g3_src_s2 --target 768p --prompt-file $K --shot 2 --note "gate3 source clip shot2"
wait $DL; ls -la /opt/models/diffusion_models/seedvr2* /opt/models/vae/seedvr2*
src() { ls -d $RUNS/*_$1 | tail -1; }
C0=$(src g2_direct768)/video.mp4; C1=$(src g3_src_s1)/video.mp4; C2=$(src g3_src_s2)/video.mp4
for n in 0 1 2; do
  eval C=\$C$n
  tm "== clip $n $C"
  $PY $D/latent_refine_local.py upscale $C g3_lbh2k_c$n --target 2k --prompt-file $K --seam guide --note "gate3 LBH 2k clip$n"
  $PY $D/upscale_video_local.py $C g3_sv7b2k_c$n --target 2k --model 7b --segment 41 --overlap 8 --dit-chunk 17 --tile 640 --tile-overlap 64
  $PY $D/upscale_video_local.py $C g3_sv15_c$n --target 2016x1152 --model 7b --segment 41 --overlap 8 --dit-chunk 17 --tile 640 --tile-overlap 64
  V=$(src g3_sv15_c$n)/video.mp4; O=$(dirname $V)/video_lanczos2k.mp4
  /usr/bin/env ffmpeg -loglevel error -y -i $V -vf scale=2688:1536:flags=lanczos -c:v libx264 -crf 12 -preset medium -an $O
  mkdir -p $RUNS/g3_lanczos_c$n; ffmpeg -loglevel error -y -i $C -vf scale=2688:1536:flags=lanczos -c:v libx264 -crf 12 -preset medium -an $RUNS/g3_lanczos_c$n/video.mp4
done
tm "GATE3_DONE"
tm "gate4 4k split 22 frames"
$PY $D/latent_refine_local.py upscale $C0 g4_4k_22 --target 4k --split --max-frames 22 --prompt-file $K --seam none --note "gate4 4k split 22f"
tm "gate4 4k split 124 frames (timeout 1800)"
$PY $D/latent_refine_local.py upscale $C0 g4_4k_124 --target 4k --split --prompt-file $K --seam guide --timeout 1800 --note "gate4 4k split 124f"
tm "ALL_DONE"
