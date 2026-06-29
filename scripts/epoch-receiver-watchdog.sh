#!/usr/bin/env bash
# Keep the Epoch telemetry receiver reachable and receiver-side calibration fresh.
#
# This script intentionally reports only health, counts, hashes, timestamps, and
# installation-agnostic file metadata. It never prints raw telemetry records.
set -euo pipefail

export PATH="${PATH:-/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

PORT="${EPOCH_RECEIVER_PORT:-3099}"
TAILNET_HOST="${EPOCH_RECEIVER_TAILNET_HOST:-nucbox.tail599928.ts.net}"
LOCAL_HEALTH="${EPOCH_RECEIVER_LOCAL_HEALTH:-http://127.0.0.1:${PORT}/health}"
TAILNET_HEALTH="${EPOCH_RECEIVER_TAILNET_HEALTH:-https://${TAILNET_HOST}:${PORT}/health}"
DATA_DIR="${EPOCH_RECEIVER_DATA_DIR:-/srv/data/epoch}"
COMPOSE_DIR="${EPOCH_RECEIVER_COMPOSE_DIR:-/srv/containers/nucbox/epoch}"
COMPOSE_SERVICE="${EPOCH_RECEIVER_COMPOSE_SERVICE:-epoch}"
CONTAINER_NAME="${EPOCH_RECEIVER_CONTAINER:-nucbox-epoch}"
CLI_PATH="${EPOCH_RECEIVER_CLI_PATH:-/usr/local/lib/node_modules/@kyanitelabs/epoch/dist/native/epoch-rust-launcher.js}"
STATUS_PATH="${EPOCH_RECEIVER_STATUS_PATH:-${DATA_DIR}/receiver-watchdog-status.json}"
STATE_PATH="${EPOCH_RECEIVER_STATE_PATH:-${DATA_DIR}/receiver-watchdog-state.json}"
LOCK_PATH="${EPOCH_RECEIVER_LOCK_PATH:-/run/epoch-receiver-watchdog.lock}"
REPAIR_ENABLED="${EPOCH_RECEIVER_REPAIR:-1}"
# Keep reference DB integration opt-in. The current receiver-safe self-improve
# path consumes the whole receiver file, so the weekly integration job is the
# safer default integration cadence.
INTEGRATION_ENABLED="${EPOCH_RECEIVER_INTEGRATE:-0}"

mkdir -p "$DATA_DIR"

log() {
  printf '[epoch-receiver-watchdog] %s\n' "$*"
}

count_jsonl() {
  local path="$1"
  if [[ -f "$path" ]]; then
    awk 'NF { count++ } END { print count + 0 }' "$path"
  else
    printf '0\n'
  fi
}

mtime_epoch() {
  local path="$1"
  if [[ -e "$path" ]]; then
    stat -c '%Y' "$path"
  else
    printf '0\n'
  fi
}

health_ok() {
  local url="$1"
  curl -kfsS --max-time 8 "$url" >/dev/null
}

serve_config_ok() {
  local status
  status="$(tailscale serve status --json 2>/dev/null || true)"
  python3 - "$TAILNET_HOST" "$PORT" "$status" <<'PY'
import json
import sys

host = sys.argv[1]
port = sys.argv[2]
try:
    data = json.loads(sys.argv[3])
except Exception:
    sys.exit(1)

web = data.get("Web", {})
entry = web.get(f"{host}:{port}", {})
handlers = entry.get("Handlers", {})
proxy = handlers.get("/", {}).get("Proxy")
tcp = data.get("TCP", {}).get(port, {})
if proxy == f"http://127.0.0.1:{port}" and tcp.get("HTTPS") is True:
    sys.exit(0)
sys.exit(1)
PY
}

repair_serve() {
  if [[ "$REPAIR_ENABLED" != "1" ]]; then
    return 1
  fi
  tailscale serve --yes --bg --https="$PORT" "$PORT" >/dev/null
}

restart_receiver() {
  if [[ "$REPAIR_ENABLED" != "1" ]]; then
    return 1
  fi
  if [[ -d "$COMPOSE_DIR" ]]; then
    (cd "$COMPOSE_DIR" && docker compose up -d "$COMPOSE_SERVICE" >/dev/null)
  elif docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    docker restart "$CONTAINER_NAME" >/dev/null
  else
    return 1
  fi
}

reference_meta() {
  python3 - "$DATA_DIR/reference-database.json" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
if not path.exists():
    print(json.dumps({"exists": False}, sort_keys=True))
    sys.exit(0)

try:
    data = json.loads(path.read_text())
except Exception as error:
    print(json.dumps({"exists": True, "validJson": False, "error": type(error).__name__}, sort_keys=True))
    sys.exit(0)
factor_payload = {
    "taskTypeCorrectionFactors": data.get("taskTypeCorrectionFactors"),
    "complexityCorrectionFactors": data.get("complexityCorrectionFactors"),
    "toolTaskCorrectionFactors": data.get("toolTaskCorrectionFactors"),
    "globalCorrectionFactor": data.get("globalCorrectionFactor"),
}
print(json.dumps({
    "exists": True,
    "validJson": True,
    "generatedAt": data.get("generatedAt"),
    "sampleSize": data.get("sampleSize"),
    "source": data.get("source"),
    "globalCorrectionFactor": data.get("globalCorrectionFactor"),
    "factorHash": hashlib.sha256(json.dumps(factor_payload, sort_keys=True).encode()).hexdigest(),
}, sort_keys=True))
PY
}

state_value() {
  local key="$1"
  python3 - "$STATE_PATH" "$key" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
key = sys.argv[2]
if not path.exists():
    print("")
    sys.exit(0)
try:
    data = json.loads(path.read_text())
except Exception:
    print("")
    sys.exit(0)
value = data.get(key, "")
print(value if value is not None else "")
PY
}

write_json() {
  local path="$1"
  shift
  python3 - "$path" "$@" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
pairs = sys.argv[2:]
data = {}
for pair in pairs:
    key, value = pair.split("=", 1)
    if value in {"true", "false"}:
        data[key] = value == "true"
    else:
        try:
            data[key] = json.loads(value)
        except Exception:
            data[key] = value
path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
PY
}

main() {
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_PATH"
    flock -n 9 || {
      log "another run is active"
      exit 0
    }
  fi

  local started_at local_ok tailnet_ok serve_ok container_restarted serve_repaired
  local integration_status previous_records current_records records_mtime before_ref after_ref
  started_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  container_restarted=false
  serve_repaired=false
  integration_status="not-run"

  if health_ok "$LOCAL_HEALTH"; then local_ok=true; else local_ok=false; fi

  if [[ "$local_ok" != "true" ]]; then
    if restart_receiver; then
      container_restarted=true
      sleep 5
    fi
    if health_ok "$LOCAL_HEALTH"; then local_ok=true; else local_ok=false; fi
  fi

  if serve_config_ok; then serve_ok=true; else serve_ok=false; fi
  if health_ok "$TAILNET_HEALTH"; then tailnet_ok=true; else tailnet_ok=false; fi

  if [[ "$local_ok" == "true" && ( "$serve_ok" != "true" || "$tailnet_ok" != "true" ) ]]; then
    if repair_serve; then
      serve_repaired=true
      sleep 3
    fi
    if serve_config_ok; then serve_ok=true; else serve_ok=false; fi
    if health_ok "$TAILNET_HEALTH"; then tailnet_ok=true; else tailnet_ok=false; fi
  fi

  previous_records="$(state_value lastRecordCount)"
  current_records="$(count_jsonl "$DATA_DIR/telemetry-records.jsonl")"
  records_mtime="$(mtime_epoch "$DATA_DIR/telemetry-records.jsonl")"
  before_ref="$(reference_meta)"
  after_ref="$before_ref"

  if [[ -z "$previous_records" ]]; then
    integration_status="state-initialized"
  elif [[ "$INTEGRATION_ENABLED" != "1" && "$current_records" -gt "$previous_records" ]]; then
    integration_status="new-records-integration-disabled"
  elif [[ "$INTEGRATION_ENABLED" == "1" && "$current_records" -gt "$previous_records" && -f "$CLI_PATH" ]]; then
    if EPOCH_DATA_DIR="$DATA_DIR" node "$CLI_PATH" self-improve >/tmp/epoch-receiver-watchdog-self-improve.log 2>&1; then
      integration_status="receiver-self-improve-ran"
      after_ref="$(reference_meta)"
    else
      integration_status="receiver-self-improve-failed"
      after_ref="$(reference_meta)"
    fi
  else
    integration_status="no-new-records"
  fi

  write_json "$STATE_PATH" \
    "lastRunAt=$started_at" \
    "lastRecordCount=$current_records" \
    "lastRecordMtime=$records_mtime" \
    "lastReferenceMeta=$after_ref" \
    "lastIntegrationStatus=$integration_status"

  write_json "$STATUS_PATH" \
    "checkedAt=$started_at" \
    "localHealthOk=$local_ok" \
    "tailnetHealthOk=$tailnet_ok" \
    "serveConfigOk=$serve_ok" \
    "containerRestarted=$container_restarted" \
    "serveRepaired=$serve_repaired" \
    "integrationStatus=$integration_status" \
    "previousRecordCount=${previous_records:-null}" \
    "currentRecordCount=$current_records" \
    "recordsMtimeEpoch=$records_mtime" \
    "referenceBefore=$before_ref" \
    "referenceAfter=$after_ref"

  cat "$STATUS_PATH"

  if [[ "$local_ok" == "true" && "$tailnet_ok" == "true" && "$serve_ok" == "true" && "$integration_status" != "receiver-self-improve-failed" ]]; then
    exit 0
  fi
  exit 1
}

main "$@"
