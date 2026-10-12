# pc-bridge (Linux/VPS port)

HTTP bridge untuk **agy CLI (Antigravity)** — kirim prompt coding dari chat (kereta, Termux, HP),
dieksekusi agy di VPS. Port Linux dari `pc-bridge.mjs` versi Windows (repo `agunggnn/mikrotik),
dengan auth device-allowlist + job async.

## Arsitektur singkat

```
HP / Termux / laptop --(tunnel)--> cloudflared --> 127.0.0.1:8999 (node pc-bridge.mjs)
                                                      |-- device allowlist (Bearer token)
                                                      |-- spawn `agy --print` per job (async)
                                                      `-- baca ~/.gemini/antigravity-cli/brain (sessions)
```

## Deploy di VPS (2C/2G cukup — CLI ringan, inferensi di cloud Google)

### 1. Install agy + login Google (SATU KALI, butuh browser)

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
~/.local/bin/agy   # ikuti login Google di browser (copy URL ke HP kalau headless)
~/.local/bin/agy models   # verifikasi login sukses
```

### 2. Clone repo kerja

```bash
mkdir -p ~/repos && cd ~/repos
git clone git@github.com:agunggnn/hetzer.git
git clone git@github.com:agunggnn/aegis-brain.git
# dst...
```

### 3. Install bridge

```bash
sudo mkdir -p /opt/pc-bridge && sudo chown $USER:$USER /opt/pc-bridge
cp pc-bridge.mjs pc-bridge.service .env.example /opt/pc-bridge/
cd /opt/pc-bridge && cp .env.example .env
# isi BRIDGE_ADMIN_TOKEN:
openssl rand -hex 32   # paste ke .env
```

### 4. systemd

```bash
sudo cp pc-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pc-bridge
journalctl -u pc-bridge -f
```

### 5. Tunnel (jangan expose port langsung!)

Arahkan Cloudflare Tunnel ke `http://127.0.0.1:8999`. Bridge bind ke localhost
saja — tidak ada alasan port 8999 terbuka ke internet.

### 6. Pairing device (authorize device aja yang bisa)

```bash
ADMIN=$(grep BRIDGE_ADMIN_TOKEN /opt/pc-bridge/.env | cut -d= -f2)

# Daftarkan HP:
curl -s -X POST https://<tunnel-host>/api/devices \
  -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"HP Agung"}'
# -> {"ok":true,"id":"...","token":"...","warning":"Simpan token ini sekarang — hanya ditampilkan SATU KALI."}
```

Simpan token di device (Termux: `export BRIDGE_TOKEN=...` di `.bashrc`, atau password manager).
Revoke: `curl -X DELETE https://<host>/api/devices/<id> -H "Authorization: Bearer $ADMIN"`.

## Pakai

```bash
T=https://<tunnel-host>; D="Authorization: Bearer $BRIDGE_TOKEN"

# Lihat session agy (pilih mau resume yang mana):
curl -s $T/api/sessions -H "$D"

# Kirim coding prompt (async -> 202):
curl -s -X POST $T/api/vibe -H "$D" -H 'Content-Type: application/json' \
  -d '{"prompt":"tambah validasi input di auth.ts","repo":"hetzer"}'

# Poll hasil:
curl -s $T/api/jobs/<jobId> -H "$D"

# Lanjutin conversation tertentu:
curl -s -X POST $T/api/vibe -H "$D" -H 'Content-Type: application/json' \
  -d '{"prompt":"lanjutkan refactornya","conversationId":"<id-dari-sessions>","repo":"hetzer"}'
```

## Endpoint

| Method | Path | Auth | Keterangan |
|---|---|---|---|
| GET | `/health` | - | health check (tanpa auth, untuk tunnel) |
| GET | `/api/sessions` | device | list conversation agy (judul + updatedAt) |
| POST | `/api/vibe` | device | `{prompt, conversationId?, repo?}` -> `202 {jobId}` |
| GET | `/api/jobs/:id` | device | status + output job (hanya milik device tsb) |
| GET | `/api/jobs` | device | 20 job terakhir milik device tsb |
| POST | `/api/devices` | admin | pairing: `{name}` -> token (1x) |
| GET | `/api/devices` | admin | list device (tanpa token) |
| DELETE | `/api/devices/:id` | admin | revoke device |

## Batas & keamanan

- Token device disimpan sebagai **hash SHA-256**; token mentah tidak pernah disimpan.
- Body max 256 KB, prompt max 8000 char, output job max 1 MB.
- Rate limit 30 req/menit per device. Max 2 job concurrent (lindungi VPS kecil).
- `repo` wajib di dalam `WORK_ROOT` (cegah path traversal).
- Timeout job 15 menit (default, via `AGY_TIMEOUT_MS`).
- Upgrade path: mTLS client certificates = device fingerprint kriptografis sejati.

## Yang dibuang dari versi Windows

- `/open` (butuh desktop Windows), `/api/chat` (intent router Ollama + telemetri
  homelab — tidak relevan di VPS), CORS `*`, `windowsHide`, timeout 45 detik,
  path hardcode `C:\...`.
