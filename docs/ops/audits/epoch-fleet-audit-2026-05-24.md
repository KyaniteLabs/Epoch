# Epoch Fleet Audit — 2026-05-24

**Run live from simons-macbook-air via Tailscale SSH.**

## Machine map

| Machine | Tailscale IP | Tailscale hostname | Status |
|---|---:|---|---|
| mac-mini | 100.115.175.18 | simons-mac-mini | ✅ Connected, up 49 days |
| ubuntu-receiver | 100.113.174.74 | nucbox | ✅ Connected, up 4 days |
| hermes-vps | 100.92.68.103 | srv1542844 | Not audited (out of scope) |

---

## Mac mini (`100.115.175.18` / `simons-mac-mini`)

### Identity
- **Hostname:** Mac.lan
- **OS:** macOS 26.4 (Build 25E246)
- **Uptime:** 49 days
- **Arch:** Apple Silicon (arm64)

### Epoch installation
- **Epoch CLI:** `/opt/homebrew/bin/epoch` ✅ installed
- **Epoch repo:** `/Users/simongonzalezdecruz/workspaces/kyanite-labs/Epoch` (branch: `main`, HEAD: `646885d`)
- **Note:** Mac mini repo is behind the branch we just pushed (expected — it's still on main)

### Epoch data files (`~/.epoch/`)
| File | Present |
|---|---|
| `config.json` | ✅ |
| `estimates.jsonl` | ✅ (225 lines) |
| `feedback.jsonl` | ✅ (285 lines) |
| `telemetry.jsonl` | ✅ (807 lines) |
| `agent-lifecycle.log` | ✅ |
| `telemetry-submit.launchd.log` | ✅ |

### Telemetry
- **launchd service:** `com.kyanitelabs.epoch.telemetry-submit` — ✅ loaded and running (PID 0, exit status 0)
- **GitHub Actions runner:** ✅ running (`actions.runner.Pushing-Squares-the-factory.mac-arm64-the-factory`)

### Factory dashboard
- **Port 8420:** ✅ Python process listening on `127.0.0.1:8420`
- **Local health check:** ✅ OK

---

## Ubuntu receiver (`100.113.174.74` / `nucbox`)

### Identity
- **Hostname:** nucbox
- **OS:** Ubuntu 24.04.4 LTS, kernel 6.17.0-1023-oem
- **Hardware:** GMKtec NucBox_EVO-X2
- **Uptime:** 4 days, 9 hours
- **Arch:** x86-64

### Epoch installation
- **Epoch CLI:** Not installed in PATH
- **Epoch HTTP server:** ✅ running (`node dist/index.js serve --port 3099`, PID 3571, started May 20)

### Receiver data files (`/srv/data/epoch/`)
| File | Lines |
|---|---:|
| `telemetry-records.jsonl` | 438 |
| `telemetry-record-keys.jsonl` | 438 |
| `telemetry-receipts.jsonl` | 33 |

### Listening ports
| Port | Bind address | Process |
|---|---|---|
| 3099 | 127.0.0.1, 100.113.174.74, Tailscale IPv6 | Epoch HTTP server |
| 8420 | 127.0.0.1 | Python3 (unrelated dashboard) |

### Health check
- `/health` → `{"status":"ok","version":"0.2.2","tools":24,"uptime":379224}` ✅
- `/v1/telemetry` endpoint available ✅
- No `~/.epoch` directory for simon user (receiver runs from `/srv/data/epoch/`)

---

## Summary

| Item | mac-mini | ubuntu-receiver |
|---|---|---|
| Machine reachable | ✅ | ✅ |
| Epoch installed | ✅ CLI | ✅ HTTP server |
| `~/.epoch` exists | ✅ (225 estimates, 285 actuals) | N/A (data at /srv/data/epoch/) |
| Telemetry configured | ✅ launchd submit | ✅ HTTP receiver on :3099 |
| Receiver collecting | N/A | ✅ 438 records, 33 receipts |
| Dashboard running | ✅ :8420 | N/A |

## Next actions
1. Push `fix/data-contribution-and-machine-truth` branch and create PR.
2. After merge, update Mac mini to latest main (`git pull`).
3. Install Epoch CLI on ubuntu-receiver for `epoch data status` capability.
4. Consider scheduling `epoch self-improve` on the Mac mini to keep reference DB fresh.
