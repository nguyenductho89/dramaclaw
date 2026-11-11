"""Extra system monitor: everything that can explain speed/quality differences besides memmon.sh.
One CSV row per interval. Model-load throughput comes from the ComfyUI process' own /proc/<pid>/io (read_bytes),
which works even when the models sit on an overlay/NFS mount where /proc/diskstats shows nothing.
  python3 sysmon.py <out.csv> [interval_s=2]
Columns: cpu_util_pct, load1, comfy_cpu_pct, comfy_read_mbps (disk), comfy_rchar_mbps (incl. page cache), comfy_threads,
gpu sm/mem clock + max, throttle reasons (hex bitmask), pcie gen/width, gpu fan/temp, ecc errors, net rx/tx MB/s.
"""
import subprocess, sys, time, glob, os

out, iv = sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 2.0
COLS = "ts_utc,cpu_util_pct,load1,comfy_pid,comfy_cpu_pct,comfy_read_mbps,comfy_rchar_mbps,comfy_write_mbps,comfy_threads,gpu_sm_mhz,gpu_mem_mhz,gpu_sm_max_mhz,gpu_throttle_hex,pcie_gen,pcie_width,gpu_temp_c,net_rx_mbps,net_tx_mbps".split(",")


def cpu_times():
    v = list(map(int, open("/proc/stat").readline().split()[1:]))
    return sum(v), v[3] + v[4]


def comfy_pid():
    for p in glob.glob("/proc/[0-9]*"):
        try:
            if b"main.py\0--listen" in open(p + "/cmdline", "rb").read():
                return int(p.split("/")[-1])
        except OSError:
            pass


def pid_io(pid):
    d = {}
    try:
        for l in open(f"/proc/{pid}/io"):
            k, v = l.split(":"); d[k] = int(v)
        st = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
        d["cpu"] = int(st[11]) + int(st[12]); d["threads"] = int(st[17])
    except OSError:
        return None
    return d


def net():
    rx = tx = 0
    for l in list(open("/proc/net/dev"))[2:]:
        n, rest = l.split(":"); f = rest.split()
        if n.strip() != "lo":
            rx += int(f[0]); tx += int(f[8])
    return rx, tx


def gpu():
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=clocks.sm,clocks.mem,clocks.max.sm,clocks_throttle_reasons.active,pcie.link.gen.current,pcie.link.width.current,temperature.gpu",
                            "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10)
        return [x.strip() for x in r.stdout.strip().split("\n")[0].split(",")]
    except Exception:  # noqa: BLE001
        return [""] * 7


hz = os.sysconf("SC_CLK_TCK")
with open(out, "w") as f:
    f.write(",".join(COLS) + "\n")
    t_prev = time.time(); c_prev = cpu_times(); pid = None; io_prev = None; n_prev = net()
    while True:
        time.sleep(iv)
        now = time.time(); dt = now - t_prev; c = cpu_times()
        cpu = round(100 * (1 - (c[1] - c_prev[1]) / max(1, c[0] - c_prev[0])), 1)
        pid = pid if pid and os.path.exists(f"/proc/{pid}") else comfy_pid()
        io = pid_io(pid) if pid else None
        rd = rc = wr = cp = th = ""
        if io and io_prev:
            rd = round((io["read_bytes"] - io_prev["read_bytes"]) / 1048576 / dt)
            rc = round((io["rchar"] - io_prev["rchar"]) / 1048576 / dt)
            wr = round((io["write_bytes"] - io_prev["write_bytes"]) / 1048576 / dt)
            cp = round(100 * (io["cpu"] - io_prev["cpu"]) / hz / dt, 1); th = io["threads"]
        n = net(); g = gpu()
        row = [time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)), cpu, open("/proc/loadavg").read().split()[0], pid or "", cp, rd, rc, wr, th,
               g[0], g[1], g[2], g[3], g[4], g[5], g[6], round((n[0] - n_prev[0]) / 1048576 / dt, 1), round((n[1] - n_prev[1]) / 1048576 / dt, 1)]
        f.write(",".join(map(str, row)) + "\n"); f.flush()
        t_prev, c_prev, io_prev, n_prev = now, c, io, n
