#!/bin/bash
# Assemble the ep01 test: chain 01 | Manim + voiceover | chain 02 | chain 03 | Three.js + voiceover | chain 04, all at 1920x1080, 24 fps.
# H3 goes to 16:9 by centre crop then Lanczos. Chain 01 also has a SeedVR2 1.5x version; both are written for comparison.
# Run from the repo root: bash previs_h3_test/scripts/skits/science_humor/assemble_ep01_test.sh <out_dir>
set -euo pipefail
OUT=${1:?out dir}; mkdir -p "$OUT"
D=previs_h3_test/scripts/skits/science_humor
RUNS=previs_h3_test/runs
chain() { ls "$RUNS"/*science_humor_ep01_chain_"$1"/video.mp4 | tail -1; }
TO1080="crop=iw:trunc(iw*9/16/2)*2,scale=1920:1080:flags=lanczos,fps=24,format=yuv420p"
AUD="-c:a aac -b:a 192k -ar 48000 -ac 2"

for c in 01 02 03 04; do
  ffmpeg -y -loglevel error -i "$(chain $c)" -vf "$TO1080" -c:v libx264 -crf 16 -preset medium $AUD "$OUT/c$c.mp4"
done
ffmpeg -y -loglevel error -i "$(ls "$RUNS"/*science_humor_ep01_upscale_1p5x/video.mp4 | tail -1)" -vf "$TO1080" -c:v libx264 -crf 16 -preset medium $AUD "$OUT/c01_seedvr2.mp4"

illus() {  # video, voiceover, output: the voiceover starts after 1 s, and the clip keeps its own length.
  ffmpeg -y -loglevel error -i "$1" -i "$2" -filter_complex "[1:a]adelay=1000|1000,apad[a]" -map 0:v -map "[a]" -shortest \
    -vf "fps=24,format=yuv420p" -c:v libx264 -crf 16 -preset medium $AUD "$3"
}
illus "$D/ep01/manim/overhang.mp4" "$D/voice/vo/manim_overhang.wav" "$OUT/manim.mp4"
illus "$D/ep01/threejs/toast.mp4" "$D/voice/vo/threejs_toast.wav" "$OUT/three.mp4"

cd "$OUT"
for v in lanczos seedvr2; do
  first=c01.mp4; [ "$v" = seedvr2 ] && first=c01_seedvr2.mp4
  printf "file '%s'\n" "$first" manim.mp4 c02.mp4 c03.mp4 three.mp4 c04.mp4 > "list_$v.txt"
  ffmpeg -y -loglevel error -f concat -safe 0 -i "list_$v.txt" -c copy "ep01_test_$v.mp4"
done
ffprobe -v error -show_entries format=duration:stream=codec_type,width,height -of compact ep01_test_lanczos.mp4
