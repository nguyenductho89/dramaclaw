#!/usr/bin/env bash
# Module acceptance runner -- can be run standalone by a human/CI, leaving log evidence throughout (the carrier of the docs/oss-split/modules/ acceptance checklists)
# Usage:
#   scripts/acceptance/run.sh M01 ce      # CE-mode acceptance of M01
#   scripts/acceptance/run.sh M02 ee      # EE mode (start PG/Redis first and set ST_CONTROL_PLANE_DSN/ST_REDIS_URL)
# Log: acceptance-logs/<module>-<mode>-<timestamp>.log (acceptance evidence, archived and not committed to git)
set -uo pipefail

MODULE=${1:?Usage: run.sh <M01..M10> <ce|ee>}
MODE=${2:?Usage: run.sh <M01..M10> <ce|ee>}
MODE_UPPER=$(printf '%s' "$MODE" | tr '[:lower:]' '[:upper:]')
PORT=${ST_ACCEPT_PORT:-8780}
TS=$(date +%Y%m%d-%H%M%S)
LOG_DIR=acceptance-logs
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/${MODULE}-${MODE}-${TS}.log"
PASS=0; FAIL=0

log()   { echo "[$(date +%T)] $*" | tee -a "$LOG"; }
check() { # check <check name> <command...> -- all command output goes into the log
  local name=$1; shift
  log "CHECK ▶ $name"
  if "$@" >>"$LOG" 2>&1; then
    log "PASS  ✔ $name"; PASS=$((PASS+1))
  else
    log "FAIL  ✘ ${name}(see the log section of the same name)"; FAIL=$((FAIL+1))
  fi
}

log "=== Acceptance $MODULE | ${MODE_UPPER} mode | HEAD $(git rev-parse --short HEAD) · $(date '+%F %T') ==="

# ---- 1. Environment (corresponds to the run-and-verify handbook in modules/INDEX.md) ----
if [ "$MODE" = ce ]; then
  export ST_EDITION=ce
  # Must be set to an explicit empty string rather than unset: on import, config.py runs
  # load_project_dotenv(override=False), which backfills unset variables from the repo-root .env;
  # an empty string is normalized to None by `or None` in Settings.from_env.
  export ST_CONTROL_PLANE_DSN= ST_REDIS_URL= ST_CELERY_BROKER_URL= ST_CELERY_RESULT_BACKEND=
  log "Environment: ST_EDITION=ce, DSN/Redis/Celery explicitly emptied (suppressing .env backfill)"
else
  : "${ST_CONTROL_PLANE_DSN:?EE mode requires ST_CONTROL_PLANE_DSN to be set}"
  : "${ST_REDIS_URL:?EE mode requires ST_REDIS_URL to be set}"
  log "Environment: EE (DSN=${ST_CONTROL_PLANE_DSN%%@*}@***)"
fi

# ---- 2. Start the backend and wait until ready ----
log "Starting backend :$PORT ..."
uv run novelvideo api --port "$PORT" >>"$LOG" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
READY=0
for _ in $(seq 1 30); do
  if curl -sf "localhost:$PORT/openapi.json" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
if [ "$READY" = 1 ]; then
  log "Backend ready"
else
  log "FAIL  ✘ Backend not ready within 30s (in CE mode with T1/T9 not landed, red is expected)"
  FAIL=$((FAIL+1))
fi

# ---- 3. pytest module marker set (the body of the machine evidence; marker registration is in testing.md section 5) ----
MARKER=$(echo "$MODULE" | tr '[:upper:]' '[:lower:]')
check "pytest -m ${MARKER} ($MODE set)" uv run pytest -m "$MARKER and not e2e" -q

# ---- 4. Module-specific curl smoke checks (checks/<module>.sh, may branch on \$MODE) ----
CHECKS="$(dirname "$0")/checks/${MARKER}.sh"
if [ -f "$CHECKS" ]; then
  # shellcheck source=/dev/null
  source "$CHECKS"
else
  log "SKIP  - no ${CHECKS} (this module's smoke checks will land with the module PR)"
fi

# ---- 5. Summary ----
log "=== Result: PASS=$PASS FAIL=$FAIL | evidence log: $LOG ==="
[ "$FAIL" -eq 0 ]
