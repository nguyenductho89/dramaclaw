"""Objective video facts for a run: ffprobe streams + ffmpeg signalstats / blur / frame sizes. Writes JSON to stdout.
  python3 video_quality.py video.mp4 [quality.json]
Not a perceptual score; use it to compare runs (brightness drift, sharpness drop at shot seams, bitrate) next to the eyeball check.
"""
import json, re, subprocess, sys


def sh(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def main(path):
    out = {"file": path}
    pr = sh(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,duration,bit_rate,sample_rate,channels:format=duration,size,bit_rate", "-of", "json", path])
    try:
        out["ffprobe"] = json.loads(pr.stdout)
    except ValueError:
        out["ffprobe_error"] = pr.stderr[-300:]
    # per-frame luma/saturation/blur via signalstats; sample 1 frame in 6 to keep it cheap
    r = sh(["ffmpeg", "-v", "error", "-i", path, "-vf", "select='not(mod(n,6))',signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-an", "-f", "null", "-"])
    y = [float(m) for m in re.findall(r"YAVG=([\d.]+)", r.stdout)]
    if y:
        n = len(y)
        out["luma"] = {"samples": n, "mean": round(sum(y) / n, 2), "first": round(y[0], 2), "last": round(y[-1], 2), "min": round(min(y), 2), "max": round(max(y), 2),
                       "max_jump": round(max(abs(a - b) for a, b in zip(y, y[1:])), 2) if n > 1 else 0,
                       "first_tenth_mean": round(sum(y[: max(1, n // 10)]) / max(1, n // 10), 2), "last_tenth_mean": round(sum(y[-max(1, n // 10):]) / max(1, n // 10), 2)}
    else:
        out["luma_error"] = (r.stderr or "no YAVG")[-300:]
    # sharpness proxy: mean of per-frame laplacian-ish via edgedetect pixel mean is not available everywhere; use packet sizes (bitrate proxy)
    p = sh(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=size", "-of", "csv=p=0", path])
    sizes = [int(x) for x in p.stdout.split() if x.isdigit()]
    if sizes:
        out["frame_bytes"] = {"count": len(sizes), "mean": round(sum(sizes) / len(sizes)), "min": min(sizes), "max": max(sizes)}
    try:
        import cv2, numpy as np  # optional
        cap = cv2.VideoCapture(path); vals = []; i = 0
        while True:
            ok, fr = cap.read()
            if not ok:
                break
            if i % 6 == 0:
                vals.append(float(cv2.Laplacian(cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()))
            i += 1
        if vals:
            out["laplacian_var"] = {"mean": round(float(np.mean(vals)), 1), "first_tenth": round(float(np.mean(vals[: max(1, len(vals) // 10)])), 1),
                                    "last_tenth": round(float(np.mean(vals[-max(1, len(vals) // 10):])), 1), "min": round(min(vals), 1)}
    except Exception as e:  # noqa: BLE001
        out["laplacian_var"] = f"skipped: {type(e).__name__}"
    return out


if __name__ == "__main__":
    res = main(sys.argv[1]); text = json.dumps(res, indent=2)
    if len(sys.argv) > 2:
        open(sys.argv[2], "w").write(text)
    print(text)
