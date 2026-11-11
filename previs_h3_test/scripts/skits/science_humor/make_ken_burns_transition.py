"""Stitch two chain videos together with a Ken Burns-style scene transition between them, free (no GPU).

Rise off the first background's still image, drift through the middle segment (by default a procedural
starfield with a small Earth dot; pass --wormhole-image for the "hold hands and fly through the wormhole"
still — see series-bible.md's "Cỗ máy wormhole" section — zoomed toward its own vanishing point instead), then
descend into the second background's still image, crossfading the whole thing with the two chain videos at the
seams. Pure ffmpeg + PIL, local, no AI video generation — this is NOT an H3 shot, so it is exempt from the
series bible's "camera cố định" rule (that rule binds H3-rendered shots only).

  uv run previs_h3_test/scripts/skits/science_humor/make_ken_burns_transition.py \
      runs/.../chain_01_single/video.mp4 gravity_test/backgrounds/orchard.png \
      gravity_test/backgrounds/moon.png runs/.../chain_02_refs_only/video.mp4 \
      runs/_science_humor_gravity_full_preview/full_preview_kenburns.mp4 \
      --wormhole-image gravity_test/transition/wormhole_flight.png

Assumes both chain videos and both background stills share the same resolution/fps (checked at runtime).
Confirmed look: previs_h3_test/science_humor_gravity_test_run.md, "Ken Burns transition" section.
"""
import argparse, json, random, subprocess, sys, tempfile
from pathlib import Path

R = Path(__file__).resolve().parents[5]


def ffprobe_json(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=width,height,r_frame_rate,sample_rate",
         "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)


def make_starfield(out_path: Path, width: int, height: int, seed: int, with_earth: bool) -> None:
    from PIL import Image, ImageDraw, ImageFilter

    random.seed(seed)
    im = Image.new("RGB", (width, height), (2, 2, 6))
    glow = Image.new("RGB", (width, height), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for _ in range(6):
        cx, cy = random.randint(0, width), random.randint(0, height)
        r = random.randint(int(height * 0.2), int(height * 0.42))
        gd.ellipse([cx - r, cy - r, cx + r, cy + r],
                   fill=(random.randint(10, 20), random.randint(5, 15), random.randint(20, 35)))
    glow = glow.filter(ImageFilter.GaussianBlur(80))
    im = Image.blend(im, glow, 0.6)
    draw = ImageDraw.Draw(im)
    for _ in range(900):
        x, y = random.randint(0, width - 1), random.randint(0, height - 1)
        b = random.randint(120, 255)
        s = random.choice([1, 1, 1, 2])
        draw.ellipse([x, y, x + s, y + s], fill=(b, b, min(255, b + 10)))
    if with_earth:
        ex, ey, er = int(width * 0.30), int(height * 0.42), max(6, int(height * 0.013))
        draw.ellipse([ex - er, ey - er, ex + er, ey + er], fill=(90, 140, 210))
        draw.ellipse([ex - er + 2, ey - er + 2, ex - er + 6, ey - er + 6], fill=(230, 240, 255))
    im.save(out_path)


def zoompan_clip(src_img: Path, out_path: Path, width: int, height: int, fps: float, dur: float,
                  zoom_expr: str, x_expr: str, y_expr: str) -> None:
    frames = max(1, round(dur * fps))
    vf = (f"scale={width}:{height},zoompan=z='{zoom_expr}':x='{x_expr}':y='{y_expr}':"
          f"d={frames}:s={width}x{height}:fps={fps},format=yuv420p")
    subprocess.run(["ffmpeg", "-y", "-loop", "1", "-i", str(src_img), "-t", str(dur), "-vf", vf, "-an",
                     str(out_path)], check=True, capture_output=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("chain_a", type=Path)
    ap.add_argument("bg_a", type=Path, help="still background image the first chain opens/closes on")
    ap.add_argument("bg_b", type=Path, help="still background image the second chain opens on")
    ap.add_argument("chain_b", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--xfade", type=float, default=0.4, help="crossfade seconds at each seam")
    ap.add_argument("--rise-dur", type=float, default=1.2)
    ap.add_argument("--star-dur", type=float, default=1.0)
    ap.add_argument("--land-dur", type=float, default=1.2)
    ap.add_argument("--star-xfade", type=float, default=0.3, help="crossfade between the 3 transition segments")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--no-earth", action="store_true", help="omit the small Earth dot in the starfield")
    ap.add_argument("--wormhole-image", type=Path, default=None,
                     help="still of the two men holding hands in the wormhole tunnel (gravity_test/transition/wormhole_flight.png) "
                          "to zoom through in the middle segment, instead of the procedural starfield")
    ap.add_argument("--video-bitrate", default="3000k")
    args = ap.parse_args()

    meta_a, meta_b = ffprobe_json(args.chain_a), ffprobe_json(args.chain_b)
    w, h = meta_a["streams"][0]["width"], meta_a["streams"][0]["height"]
    if (meta_b["streams"][0]["width"], meta_b["streams"][0]["height"]) != (w, h):
        sys.exit(f"resolution mismatch: chain_a {w}x{h} vs chain_b {meta_b['streams'][0]['width']}x{meta_b['streams'][0]['height']}")
    num, den = meta_a["streams"][0]["r_frame_rate"].split("/")
    fps = float(num) / float(den)
    sample_rate = next((s["sample_rate"] for s in meta_a["streams"] if "sample_rate" in s), "32000")
    dur_a = float(meta_a["format"]["duration"])

    with tempfile.TemporaryDirectory() as tmp:
        t = Path(tmp)
        rise = t / "t1_rise.mp4"
        star = t / "t2_star.mp4"
        land = t / "t3_land.mp4"

        if args.wormhole_image:
            # Zoom straight toward the image's own vanishing point (it already reads as a tunnel receding to
            # its center) to read as
            # "being pulled through", rather than the generic small pan used for the plain starfield.
            zoompan_clip(args.wormhole_image, star, w, h, fps, args.star_dur,
                         zoom_expr="min(1.0+0.09*on,1.9)", x_expr="iw/2-(iw/zoom/2)", y_expr="ih/2-(ih/zoom/2)")
        else:
            star_png = t / "starfield.png"
            make_starfield(star_png, w, h, args.seed, not args.no_earth)
            zoompan_clip(star_png, star, w, h, fps, args.star_dur,
                         zoom_expr="min(1.02+0.0008*on,1.08)", x_expr="iw/2-(iw/zoom/2)", y_expr="ih/2-(ih/zoom/2)")

        zoompan_clip(args.bg_a, rise, w, h, fps, args.rise_dur,
                     zoom_expr="min(zoom+0.0045,1.35)", x_expr="iw/2-(iw/zoom/2)",
                     y_expr=f"max(0,ih-ih*0.55-ih*(1-on/{max(1, round(args.rise_dur * fps))}))")
        zoompan_clip(args.bg_b, land, w, h, fps, args.land_dur,
                     zoom_expr="max(1.30-0.0045*on,1.0)", x_expr="iw/2-(iw/zoom/2)", y_expr="ih/2-(ih/zoom/2)")

        trans_v = t / "transition.mp4"
        off1 = args.rise_dur - args.star_xfade
        off2 = off1 + args.star_dur - args.star_xfade
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(rise), "-i", str(star), "-i", str(land), "-filter_complex",
             f"[0:v][1:v]xfade=transition=fade:duration={args.star_xfade}:offset={off1}[v01];"
             f"[v01][2:v]xfade=transition=fade:duration={args.star_xfade}:offset={off2}[v]",
             "-map", "[v]", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(trans_v)],
            check=True, capture_output=True,
        )
        trans_dur = float(ffprobe_json(trans_v)["format"]["duration"])

        trans_av = t / "transition_av.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(trans_v), "-f", "lavfi", "-i",
             f"anullsrc=channel_layout=stereo:sample_rate={sample_rate}", "-shortest", "-c:v", "copy",
             "-c:a", "aac", "-b:a", "128k", str(trans_av)],
            check=True, capture_output=True,
        )

        off1 = dur_a - args.xfade
        off2 = off1 + trans_dur - args.xfade
        args.out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(args.chain_a), "-i", str(trans_av), "-i", str(args.chain_b),
             "-filter_complex",
             f"[0:v][1:v]xfade=transition=fade:duration={args.xfade}:offset={off1}[v01];"
             f"[v01][2:v]xfade=transition=fade:duration={args.xfade}:offset={off2}[v];"
             f"[0:a][1:a]acrossfade=d={args.xfade}[a01];[a01][2:a]acrossfade=d={args.xfade}[a]",
             "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-b:v", args.video_bitrate,
             "-maxrate", args.video_bitrate, "-bufsize", "6000k", "-c:a", "aac", "-b:a", "128k", str(args.out)],
            check=True, capture_output=True,
        )
    print(f"wrote {args.out} ({ffprobe_json(args.out)['format']['duration']}s)")


if __name__ == "__main__":
    main()
