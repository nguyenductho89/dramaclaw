"""Split an H3 multishot ComfyUI log into per-shot phase timings.

Input: a log whose lines start with "YYYY-MM-DDTHH:MM:SS " (worker logs from RunPod, or the box log written by
tslog.py). Output (stdout or the path given as 2nd arg): JSON with one entry per shot.

Phases (from the markers seen in bench_4090_ms30_events.log):
  encode_text   "shot N/M (" -> "TE evicted"
  dit           "TE evicted" -> next "Requested to load MiniMaxH3VideoVAE"   (includes init + sampling)
  init          tqdm "<x>s/it, Model Initialization" on step 1
  sampling      elapsed of the first "S/S [mm:ss" progress line (S = steps)
  decode_video  that VideoVAE request -> "Requested to load MiniMaxH3AudioVAE"
  decode_audio  AudioVAE request -> "shot N/M saved"
A phase whose markers are missing is null and listed in "missing"; nothing is guessed.

  python parse_h3_log.py comfy.log [phases.json]
"""
import json, re, sys
from datetime import datetime

TS = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)")
SHOT_START = re.compile(r"\[H3Multishot\] shot (\d+)/(\d+) \(")
SHOT_SAVED = re.compile(r"\[H3Multishot\] shot (\d+)/(\d+) saved")
TE_EVICTED = re.compile(r"TE evicted; ([\d.]+) GB free")
INIT = re.compile(r"([\d.]+)s/it,\s+Model Initialization")
DONE = re.compile(r"(\d+)/\1 \[(\d+):(\d+)<[^,]*, *([\d.]+)s/it\]")
STAGED = re.compile(r"Model (\S+) prepared for dynamic VRAM loading\. (\d+)MB Staged\. (\d+) patches")
STORAGE = re.compile(r"Model storage policy: (fast_disk=\w+)")


def parse(lines):
    shots, cur, notes = [], None, {"storage_policy": set(), "staged_mb": {}}
    for line in lines:
        m = TS.match(line)
        if not m:
            continue
        t = datetime.fromisoformat(m.group(1))
        if (s := STORAGE.search(line)):
            notes["storage_policy"].add(s.group(1))
        if (s := STAGED.search(line)):
            notes["staged_mb"][s.group(1)] = int(s.group(2))
        if (s := SHOT_START.search(line)):
            cur = {"shot": int(s.group(1)), "of": int(s.group(2)), "t": {"start": t}, "init_s": None, "sampling_s": None,
                   "s_per_step": None, "dit_free_gb": None}
            shots.append(cur)
            continue
        if cur is None:
            continue
        tt = cur["t"]
        if (s := TE_EVICTED.search(line)) and "te_evicted" not in tt:
            tt["te_evicted"] = t; cur["dit_free_gb"] = float(s.group(1))
        elif "te_evicted" in tt:
            if cur["init_s"] is None and (s := INIT.search(line)):
                cur["init_s"] = float(s.group(1))
            if cur["sampling_s"] is None and (s := DONE.search(line)):
                cur["sampling_s"] = int(s.group(2)) * 60 + int(s.group(3)); cur["s_per_step"] = float(s.group(4))
            if "Requested to load MiniMaxH3VideoVAE" in line and "video_vae" not in tt:
                tt["video_vae"] = t
            elif "Requested to load MiniMaxH3AudioVAE" in line and "audio_vae" not in tt:
                tt["audio_vae"] = t
        if SHOT_SAVED.search(line):
            tt["saved"] = t
            cur = None

    def span(tt, a, b):
        return (tt[b] - tt[a]).total_seconds() if a in tt and b in tt else None

    out = []
    for s in shots:
        tt = s.pop("t")
        rec = {"shot": s["shot"], "of": s["of"], "start": tt["start"].isoformat(),
               "encode_text_s": span(tt, "start", "te_evicted"), "dit_s": span(tt, "te_evicted", "video_vae"),
               "init_s": s["init_s"], "sampling_s": s["sampling_s"], "s_per_step": s["s_per_step"],
               "decode_video_s": span(tt, "video_vae", "audio_vae"), "decode_audio_s": span(tt, "audio_vae", "saved"),
               "shot_total_s": span(tt, "start", "saved"), "dit_free_gb": s["dit_free_gb"]}
        rec["missing"] = [k for k, v in rec.items() if v is None]
        out.append(rec)
    return {"shots": out, "storage_policy": sorted(notes["storage_policy"]), "staged_mb": notes["staged_mb"]}


def summary(res):
    def avg(k):
        v = [s[k] for s in res["shots"] if s[k] is not None]
        return round(sum(v) / len(v), 1) if v else None
    return {k: avg(k) for k in ("encode_text_s", "dit_s", "init_s", "sampling_s", "s_per_step", "decode_video_s",
                                "decode_audio_s", "shot_total_s")}


if __name__ == "__main__":
    with open(sys.argv[1], errors="replace") as f:
        res = parse(f)
    res["avg"] = summary(res)
    text = json.dumps(res, indent=2)
    if len(sys.argv) > 2:
        open(sys.argv[2], "w").write(text)
    else:
        print(text)
