"""Prefix every line (split on \\n and \\r, so tqdm progress updates count as lines) with a UTC
"YYYY-MM-DDTHH:MM:SS " stamp and append to a file, echoing to stdout. Same format as the RunPod worker
logs that parse_h3_log.py reads.
  python -u main.py ... 2>&1 | python3 -u tslog.py /opt/bench/comfy_server.log
"""
import sys, time

out = open(sys.argv[1], "a", buffering=1, errors="replace")
buf = ""
for chunk in iter(lambda: sys.stdin.read(1), ""):
    if chunk in "\r\n":
        if buf.strip():
            line = time.strftime("%Y-%m-%dT%H:%M:%S ", time.gmtime()) + buf
            out.write(line + "\n"); sys.stdout.write(line + "\n"); sys.stdout.flush()
        buf = ""
    else:
        buf += chunk
