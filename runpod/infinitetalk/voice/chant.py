"""VieNeu v3 Turbo -> giọng tụng kinh: ít lên xuống, trầm, chậm, đều, có vang.
Usage: venv/bin/python chant.py input.txt out.wav [--alpha 0.25] [--stretch 0.75] [--semi -1.5] [--max N]
"""
import argparse, re, time
import numpy as np, pyworld as pw, soundfile as sf
from pedalboard import Pedalboard, Reverb, LowShelfFilter, Compressor, time_stretch
from vn_load import load

ap = argparse.ArgumentParser()
ap.add_argument("src"); ap.add_argument("dst")
ap.add_argument("--voice", default="Thiền Tâm Đức")
ap.add_argument("--alpha", type=float, default=0.25)   # 1 = giữ nguyên ngữ điệu, 0 = đơn âm hoàn toàn
ap.add_argument("--stretch", type=float, default=0.75) # <1 = chậm
ap.add_argument("--semi", type=float, default=-1.5)    # hạ cao độ (nửa cung)
ap.add_argument("--temp", type=float, default=0.3)
ap.add_argument("--pause", type=float, default=1.0)
ap.add_argument("--wet", type=float, default=0.18)
ap.add_argument("--max", type=int, default=0)
ap.add_argument("--room", type=float, default=0.45)
a = ap.parse_args()

def split_lines(t):
    out = []
    for ln in t.splitlines():
        ln = ln.strip()
        if not ln: continue
        for p in re.split(r"(?<=[.!?])\s+", ln):
            while len(p) > 200:
                c = p.rfind(",", 0, 200); c = c if c > 40 else p.rfind(" ", 0, 200)
                out.append(p[:c+1].strip()); p = p[c+1:].strip()
            if p: out.append(p)
    return out

def flatten(y, sr, alpha, semi):
    x = y.astype(np.float64)
    f0, t = pw.dio(x, sr, f0_floor=60, f0_ceil=300, frame_period=5.0)
    f0 = pw.stonemask(x, f0, t, sr)
    sp = pw.cheaptrick(x, f0, t, sr); apr = pw.d4c(x, f0, t, sr)
    v = f0 > 0
    if v.sum() > 10:
        lf = np.log(f0[v]); m = lf.mean()
        k = 9; sm = np.convolve(lf, np.ones(k)/k, mode="same")  # làm mượt đường cao độ
        f0[v] = np.exp(m + alpha * (sm - m)) * 2 ** (semi / 12)
    return pw.synthesize(f0, sp, apr, sr, 5.0).astype(np.float32)

lines = split_lines(open(a.src, encoding="utf-8").read())
if a.max: lines = lines[:a.max]
tts = load(); voice = tts.get_preset_voice(a.voice); sr = tts.sample_rate
chunks, t0 = [], time.time()
for i, s in enumerate(lines, 1):
    w = np.asarray(tts.infer(text=s, voice=voice, silence_p=0.4, temperature=a.temp), dtype=np.float32)
    w = time_stretch(w[None, :], sr, stretch_factor=a.stretch, pitch_shift_in_semitones=0,
                     high_quality=True, preserve_formants=True)[0]
    w = flatten(w, sr, a.alpha, a.semi)
    chunks += [w, np.zeros(int(a.pause * sr), np.float32)]
    print(f"{i}/{len(lines)} {len(w)/sr:.1f}s elapsed {time.time()-t0:.0f}s", flush=True)
y = np.concatenate(chunks)
board = Pedalboard([LowShelfFilter(250, 2.5), Compressor(-20, 3), Reverb(room_size=a.room, damping=0.6, wet_level=a.wet, dry_level=1.0)])
y = board(y[None, :], sr)[0]
y = y / max(1.0, float(np.abs(y).max()) * 1.05)
sf.write(a.dst, y, sr, subtype="PCM_16"); print("done", a.dst, round(len(y)/sr, 1), "s")
