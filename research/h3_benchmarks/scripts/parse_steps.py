"""Per-step sampling times from a timestamped ComfyUI log (tslog format) -> JSON. Works for 1-shot and multishot logs.
  python parse_steps.py comfy.log [steps.json]
Each progress bar (one per sampler pass: a shot, a stage-2 pass, ...) becomes {"total": M, "steps": [{"step", "t_utc", "elapsed_s",
"step_s"}], "first_step_s", "median_step_s"}. The first step of a bar includes "Model Initializing", so median_step_s excludes it.
"""
import json, re, statistics, sys

TS = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)")
BAR = re.compile(r"\b(\d+)/(\d+) \[(\d+):(\d\d)(?::(\d\d))?<")


def parse(lines):
    """step_s = wall-clock gap between the log lines where step N-1 and N first appear (tqdm's own s/it is a moving average and its
    elapsed timer restarts after "Model Initializing", so it can't be differenced). The first step of a bar is measured from the
    bar's "0/M" line, so it includes model initialization."""
    from datetime import datetime
    bars, cur = [], None
    for line in lines:
        ts = TS.match(line)
        t = datetime.fromisoformat(ts.group(1)) if ts else None
        for m in BAR.finditer(line):
            step, total = int(m.group(1)), int(m.group(2))
            if total < 2:
                continue
            if step == 0:
                if cur is None or cur["steps"] or cur["total"] != total:
                    cur = {"total": total, "start": t, "steps": [], "_last": t}; bars.append(cur)
                continue
            if cur is not None and cur["total"] == total and cur["steps"] and step == cur["steps"][-1]["step"]:
                continue
            if cur is None or cur["total"] != total or (cur["steps"] and step < cur["steps"][-1]["step"]):
                cur = {"total": total, "start": None, "steps": [], "_last": None}; bars.append(cur)
            base = cur["_last"]
            cur["steps"].append({"step": step, "t_utc": ts.group(1) if ts else None,
                                 "step_s": (t - base).total_seconds() if (t and base) else None, "tqdm_s_per_it": m.group(0) and None})
            cur["_last"] = t
    for b in bars:
        s = [x["step_s"] for x in b["steps"] if x["step_s"] is not None]
        b["first_step_s"] = s[0] if s else None
        b["median_step_s"] = statistics.median(s[1:]) if len(s) > 1 else None
        b["start"] = b["start"].isoformat() if b["start"] else None
        del b["_last"]
        for x in b["steps"]:
            x.pop("tqdm_s_per_it", None)
    return {"bars": bars}


if __name__ == "__main__":
    with open(sys.argv[1], errors="replace") as f:
        res = parse(f)
    text = json.dumps(res, indent=2)
    if len(sys.argv) > 2:
        open(sys.argv[2], "w").write(text)
    else:
        print(json.dumps([{"total": b["total"], "n": len(b["steps"]), "first": b["first_step_s"], "median": b["median_step_s"]} for b in res["bars"]]))
