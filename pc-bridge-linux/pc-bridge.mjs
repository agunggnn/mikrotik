// ============================================================================
// pc-bridge (Linux/VPS port) — HTTP bridge untuk agy CLI (Antigravity)
// ----------------------------------------------------------------------------
// Port dari pc-bridge.mjs versi Windows (repo agunggnn/mikrotik), dengan:
//  - Semua path & binary lewat env (tidak ada hardcode C:\...)
//  - Auth: device allowlist. Tiap device punya token sendiri (dibuat sekali
//    via /api/devices pakai admin token, token hanya ditampilkan 1x).
//    Hanya device terdaftar yang bisa akses. Token long-lived = "auto enable".
//  - /api/vibe berjalan ASYNC: 202 + job id, polling via /api/jobs/:id
//    (timeout 45 detik versi lama terlalu pendek untuk coding task).
//  - Bagian Windows-only dibuang (/open -> cmd.exe start, windowsHide).
//  - CORS * dibuang (ini machine API, bukan browser).
//  - Body size cap + rate limit per device + bind default 127.0.0.1.
//  - Upgrade path: mTLS client certificates (device fingerprint kriptografis).
//
// Zero dependency: hanya modul bawaan Node.js (>= 20).
// ============================================================================
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Konfigurasi (env, dengan .env loader sederhana tanpa dependency)
// ---------------------------------------------------------------------------
try {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envFile = fs.readFileSync(envPath, 'utf8');
    envFile.split('\n').forEach((line) => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match && !line.trim().startsWith('#')) {
        const key = match[1];
        let value = (match[2] || '').trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = value;
      }
    });
  }
} catch (e) { /* .env opsional */ }

const HOME = os.homedir();
const defaultAgy = path.join(HOME, '.local', 'bin', 'agy');

const CONFIG = {
  port: parseInt(process.env.PORT || '8999', 10),
  bind: process.env.BIND || '127.0.0.1',
  agyBin: process.env.AGY_BIN || (fs.existsSync(defaultAgy) ? defaultAgy : 'agy'),
  brainDir: process.env.BRAIN_DIR || path.join(HOME, '.gemini', 'antigravity-cli', 'brain'),
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), 'data'),
  workRoot: path.resolve(process.env.WORK_ROOT || path.join(HOME, 'repos')),
  adminToken: process.env.BRIDGE_ADMIN_TOKEN || '',
  agyTimeoutMs: parseInt(process.env.AGY_TIMEOUT_MS || '900000', 10), // 15 menit
  maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS || '2', 10),
  maxBodyBytes: parseInt(process.env.MAX_BODY_BYTES || '262144', 10), // 256 KB
  rateLimitPerMin: parseInt(process.env.RATE_LIMIT_PER_MIN || '30', 10),
  maxOutputBytes: 1024 * 1024, // 1 MB cap output per job
  maxPromptChars: 8000,
};

if (!CONFIG.adminToken) {
  console.error('[PC-BRIDGE] FATAL: BRIDGE_ADMIN_TOKEN belum di-set. Generate: openssl rand -hex 32');
  process.exit(1);
}
const ADMIN_HASH = sha256(CONFIG.adminToken);
CONFIG.adminToken = ''; // jangan simpan token mentah di memori lebih lama dari perlu

if (!fs.existsSync(CONFIG.agyBin) && CONFIG.agyBin !== 'agy') {
  console.warn(`[PC-BRIDGE] WARNING: AGY_BIN tidak ditemukan di ${CONFIG.agyBin}`);
}

for (const d of [CONFIG.dataDir, path.join(CONFIG.dataDir, 'jobs'), CONFIG.workRoot]) {
  fs.mkdirSync(d, { recursive: true });
}

const DEVICES_FILE = path.join(CONFIG.dataDir, 'devices.json');
const JOBS_DIR = path.join(CONFIG.dataDir, 'jobs');

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
function safeEqual(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// Device registry (allowlist): hanya device terdaftar yang bisa akses.
// Token disimpan sebagai hash; token mentah hanya ditampilkan 1x saat pairing.
// ---------------------------------------------------------------------------
function loadDevices() {
  try {
    const raw = fs.readFileSync(DEVICES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.devices) ? parsed.devices : [];
  } catch {
    return [];
  }
}
function saveDevices(devices) {
  const tmp = DEVICES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ devices }, null, 2));
  fs.renameSync(tmp, DEVICES_FILE); // atomic write
}
function findDeviceByToken(token) {
  if (!token) return null;
  const h = sha256(token);
  return loadDevices().find((d) => d.tokenHash && safeEqual(d.tokenHash, h)) || null;
}
function touchDevice(id) {
  const devices = loadDevices();
  const d = devices.find((x) => x.id === id);
  if (d) {
    d.lastSeenAt = new Date().toISOString();
    d.requestCount = (d.requestCount || 0) + 1;
    saveDevices(devices);
  }
}

// ---------------------------------------------------------------------------
// Rate limiter sederhana per device (in-memory)
// ---------------------------------------------------------------------------
const rateBuckets = new Map(); // deviceId -> [timestamps]
function checkRateLimit(deviceId) {
  const now = Date.now();
  const windowMs = 60_000;
  const hits = (rateBuckets.get(deviceId) || []).filter((t) => now - t < windowMs);
  if (hits.length >= CONFIG.rateLimitPerMin) return false;
  hits.push(now);
  rateBuckets.set(deviceId, hits);
  return true;
}

// ---------------------------------------------------------------------------
// Helpers HTTP
// ---------------------------------------------------------------------------
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > CONFIG.maxBodyBytes) {
        reject(new Error('Body terlalu besar'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}
function bearerToken(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// ---------------------------------------------------------------------------
// agy sessions: baca conversation dari brain dir (untuk "resume pakai yang mana")
// ---------------------------------------------------------------------------
async function getFirstLine(filePath) {
  try {
    const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    for await (const line of rl) {
      rl.close();
      fileStream.destroy();
      return line;
    }
  } catch { return null; }
  return null;
}
async function getSessions() {
  try {
    await fsp.access(CONFIG.brainDir);
  } catch {
    return [];
  }
  const dirs = await fsp.readdir(CONFIG.brainDir, { withFileTypes: true });
  const sessions = [];
  for (const d of dirs.filter((x) => x.isDirectory() && !x.name.startsWith('.'))) {
    const transcriptPath = path.join(CONFIG.brainDir, d.name, '.system_generated', 'logs', 'transcript.jsonl');
    try { await fsp.access(transcriptPath); } catch { continue; }
    const stat = await fsp.stat(transcriptPath);
    const firstLine = await getFirstLine(transcriptPath);
    let title = 'Sesi Tanpa Judul';
    if (firstLine) {
      try {
        const parsed = JSON.parse(firstLine);
        const content = parsed.content || '';
        const m = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
        title = (m ? m[1] : content).trim().replace(/\r?\n/g, ' ').slice(0, 90) || 'Sesi Antigravity';
      } catch { /* pakai default */ }
    }
    sessions.push({ id: d.name, title, updatedAt: stat.mtime });
  }
  sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return sessions.slice(0, 20);
}

// ---------------------------------------------------------------------------
// Async jobs: /api/vibe -> 202 + jobId, hasil via /api/jobs/:id
// ---------------------------------------------------------------------------
const activeChildren = new Set();
function runningJobCount() {
  return activeChildren.size;
}
function jobPath(id) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return null;
  return path.join(JOBS_DIR, `${id}.json`);
}
function readJob(id) {
  const p = jobPath(id);
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function writeJob(job) {
  const p = jobPath(job.id);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(job));
  fs.renameSync(tmp, p);
}
function resolveWorkDir(repo) {
  // repo opsional; harus tetap di dalam WORK_ROOT (cegah path traversal)
  const target = path.resolve(CONFIG.workRoot, repo || '.');
  if (target !== CONFIG.workRoot && !target.startsWith(CONFIG.workRoot + path.sep)) {
    return null;
  }
  return target;
}
function startAgyJob({ prompt, conversationId, cwd, deviceId }) {
  const job = {
    id: crypto.randomUUID(),
    status: 'running',
    prompt: prompt.slice(0, 200),
    conversationId: conversationId || null,
    cwd,
    deviceId,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    output: '',
    truncated: false,
  };
  const args = [];
  if (conversationId) args.push('--conversation', conversationId);
  else args.push('--continue');
  args.push('--print', prompt);

  console.log(`[PC-BRIDGE] Job ${job.id} start (device=${deviceId}, cwd=${cwd})`);
  const child = spawn(CONFIG.agyBin, args, { cwd, env: { ...process.env } });
  activeChildren.add(child);
  writeJob(job);

  let stdout = '';
  let stderr = '';
  const cap = (s, chunk) => {
    if (s.length >= CONFIG.maxOutputBytes) { job.truncated = true; return s; }
    const next = s + chunk;
    if (next.length > CONFIG.maxOutputBytes) job.truncated = true;
    return next.slice(0, CONFIG.maxOutputBytes);
  };
  child.stdout.on('data', (c) => { stdout = cap(stdout, c.toString()); });
  child.stderr.on('data', (c) => { stderr = cap(stderr, c.toString()); });

  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
    job.status = 'timeout';
    job.finishedAt = new Date().toISOString();
    job.output = (stdout.trim() || stderr.trim() || 'Timeout: agy tidak selesai dalam batas waktu.');
    writeJob(job);
    console.warn(`[PC-BRIDGE] Job ${job.id} timeout, di-kill`);
  }, CONFIG.agyTimeoutMs);
  // jangan tahan event loop hanya karena timer job
  if (timer.unref) timer.unref();

  child.on('error', (err) => {
    clearTimeout(timer);
    activeChildren.delete(child);
    job.status = 'error';
    job.finishedAt = new Date().toISOString();
    job.output = `Gagal menjalankan agy: ${err.message}`;
    writeJob(job);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    activeChildren.delete(child);
    if (job.status === 'timeout') return; // sudah ditulis oleh timer
    job.status = code === 0 ? 'done' : 'error';
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    job.output = stdout.trim() || stderr.trim() || '(tidak ada output)';
    writeJob(job);
    console.log(`[PC-BRIDGE] Job ${job.id} selesai: ${job.status} (exit ${code})`);
  });
  return job;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // 1. Health check — tanpa auth (untuk tunnel / monitoring)
  if ((pathname === '/' || pathname === '/health') && req.method === 'GET') {
    return sendJSON(res, 200, {
      status: 'ok', service: 'pc-bridge', platform: 'linux',
      uptime: Math.round(process.uptime()), timestamp: Date.now(),
    });
  }

  // ---- Admin routes: butuh BRIDGE_ADMIN_TOKEN ----
  const isAdminPath = pathname.startsWith('/api/devices');
  if (isAdminPath) {
    const token = bearerToken(req);
    if (!token || !safeEqual(sha256(token), ADMIN_HASH)) {
      return sendJSON(res, 401, { ok: false, error: 'Admin token tidak valid.' });
    }
    // POST /api/devices — pairing device baru (token ditampilkan 1x)
    if (pathname === '/api/devices' && req.method === 'POST') {
      let body;
      try { body = await parseBody(req); } catch { return sendJSON(res, 413, { ok: false, error: 'Body terlalu besar.' }); }
      const name = (body.name || '').trim().slice(0, 60);
      if (!name) return sendJSON(res, 400, { ok: false, error: 'name wajib diisi.' });
      const tokenNew = crypto.randomBytes(32).toString('hex');
      const devices = loadDevices();
      const device = {
        id: crypto.randomUUID(), name,
        tokenHash: sha256(tokenNew),
        createdAt: new Date().toISOString(), lastSeenAt: null, requestCount: 0,
      };
      devices.push(device);
      saveDevices(devices);
      console.log(`[PC-BRIDGE] Device paired: ${name} (${device.id})`);
      return sendJSON(res, 201, {
        ok: true, id: device.id, name,
        token: tokenNew,
        warning: 'Simpan token ini sekarang — hanya ditampilkan SATU KALI.',
      });
    }
    // GET /api/devices — list device (tanpa token)
    if (pathname === '/api/devices' && req.method === 'GET') {
      const devices = loadDevices().map(({ tokenHash, ...d }) => d);
      return sendJSON(res, 200, { ok: true, count: devices.length, devices });
    }
    // DELETE /api/devices/:id — revoke device
    const delMatch = pathname.match(/^\/api\/devices\/([a-zA-Z0-9-]+)$/);
    if (delMatch && req.method === 'DELETE') {
      const devices = loadDevices();
      const idx = devices.findIndex((d) => d.id === delMatch[1]);
      if (idx === -1) return sendJSON(res, 404, { ok: false, error: 'Device tidak ditemukan.' });
      const [removed] = devices.splice(idx, 1);
      saveDevices(devices);
      console.log(`[PC-BRIDGE] Device revoked: ${removed.name} (${removed.id})`);
      return sendJSON(res, 200, { ok: true, revoked: removed.id });
    }
    return sendJSON(res, 404, { ok: false, error: 'Endpoint tidak ditemukan.' });
  }

  // ---- Device routes: hanya device terdaftar ----
  const deviceToken = bearerToken(req);
  const device = findDeviceByToken(deviceToken);
  if (!device) {
    return sendJSON(res, 401, { ok: false, error: 'Device tidak dikenal. Pairing dulu via admin.' });
  }
  if (!checkRateLimit(device.id)) {
    return sendJSON(res, 429, { ok: false, error: 'Rate limit terlampaui, coba lagi sebentar.' });
  }
  touchDevice(device.id);

  // 2. GET /api/sessions — daftar conversation agy (untuk pilih resume)
  if (pathname === '/api/sessions' && req.method === 'GET') {
    try {
      const sessions = await getSessions();
      return sendJSON(res, 200, { ok: true, count: sessions.length, sessions });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // 3. POST /api/vibe — jalankan prompt agy secara async
  if (pathname === '/api/vibe' && req.method === 'POST') {
    let body;
    try { body = await parseBody(req); } catch { return sendJSON(res, 413, { ok: false, error: 'Body terlalu besar.' }); }
    const prompt = (body.prompt || '').trim();
    const conversationId = (body.conversationId || '').trim();
    const repo = (body.repo || '').trim();
    if (!prompt) return sendJSON(res, 400, { ok: false, error: 'prompt tidak boleh kosong.' });
    if (prompt.length > CONFIG.maxPromptChars) {
      return sendJSON(res, 400, { ok: false, error: `prompt maksimal ${CONFIG.maxPromptChars} karakter.` });
    }
    if (conversationId && !/^[a-zA-Z0-9-]+$/.test(conversationId)) {
      return sendJSON(res, 400, { ok: false, error: 'Format conversationId tidak valid.' });
    }
    const cwd = resolveWorkDir(repo);
    if (!cwd) return sendJSON(res, 400, { ok: false, error: 'repo tidak valid (harus di dalam WORK_ROOT).' });
    if (runningJobCount() >= CONFIG.maxConcurrentJobs) {
      return sendJSON(res, 429, { ok: false, error: 'Slot job penuh, coba lagi nanti.' });
    }
    const job = startAgyJob({ prompt, conversationId: conversationId || null, cwd, deviceId: device.id });
    return sendJSON(res, 202, {
      ok: true, jobId: job.id, status: job.status,
      poll: `/api/jobs/${job.id}`,
    });
  }

  // 4. GET /api/jobs/:id — status & hasil job
  const jobMatch = pathname.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)$/);
  if (jobMatch && req.method === 'GET') {
    const job = readJob(jobMatch[1]);
    if (!job || job.deviceId !== device.id) {
      return sendJSON(res, 404, { ok: false, error: 'Job tidak ditemukan.' });
    }
    return sendJSON(res, 200, { ok: true, job });
  }

  // 5. GET /api/jobs — job-job terbaru milik device ini
  if (pathname === '/api/jobs' && req.method === 'GET') {
    try {
      const files = await fsp.readdir(JOBS_DIR);
      const jobs = [];
      for (const f of files.filter((x) => x.endsWith('.json')).slice(-50)) {
        try {
          const j = JSON.parse(await fsp.readFile(path.join(JOBS_DIR, f), 'utf8'));
          if (j.deviceId === device.id) {
            const { output, ...meta } = j;
            jobs.push({ ...meta, outputChars: (output || '').length });
          }
        } catch { /* skip file rusak */ }
      }
      jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return sendJSON(res, 200, { ok: true, count: jobs.length, jobs: jobs.slice(0, 20) });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  return sendJSON(res, 404, { ok: false, error: 'Endpoint tidak ditemukan.' });
});

server.listen(CONFIG.port, CONFIG.bind, () => {
  console.log(`[PC-BRIDGE] Listening on http://${CONFIG.bind}:${CONFIG.port}`);
  console.log(`[PC-BRIDGE] agy: ${CONFIG.agyBin} | brain: ${CONFIG.brainDir} | work: ${CONFIG.workRoot}`);
});

// Graceful shutdown
function gracefulShutdown() {
  console.log('\n[PC-BRIDGE] Shutting down gracefully...');
  for (const child of activeChildren) {
    try { child.kill('SIGTERM'); } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
