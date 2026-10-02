import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { exec, spawn } from 'node:child_process';

const PORT = 8999;
const AGY_BIN = 'C:\\Users\\agung\\AppData\\Local\\agy\\bin\\agy.exe';
const BRAIN_DIR = 'C:\\Users\\agung\\.gemini\\antigravity-cli\\brain';
const CURRENT_CONV_ID = 'b2b3d85f-5688-4181-adce-c5decd473bf5';
const OLLAMA_URL = 'http://127.0.0.1:11434/api/generate';

// Track active child processes for graceful shutdown
const activeChildren = new Set();

// Simple .env loader to avoid external dependencies
try {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envFile = fs.readFileSync(envPath, 'utf8');
    envFile.split('\n').forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = (match[2] || '').trim();
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        if (!process.env[key]) process.env[key] = value;
      }
    });
  }
} catch (e) {}

const HA_URL = process.env.HA_URL || 'http://127.0.0.1:8123';
const HA_TOKEN = process.env.HA_TOKEN || '';
const MIKROTIK_URL = process.env.MIKROTIK_URL || 'http://192.168.88.1/rest';
const MIKROTIK_USER = process.env.MIKROTIK_USER || 'admin';
const MIKROTIK_PASS = process.env.MIKROTIK_PASS || '';

// Helper: send JSON with CORS
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

// Helper: read request body
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

// Helper: get first line of a file
async function getFirstLine(filePath) {
  try {
    const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    for await (const line of rl) {
      rl.close();
      fileStream.destroy();
      return line;
    }
  } catch (e) {
    return null;
  }
  return null;
}

// Helper: Fetch Home Assistant state
async function getHAState() {
  if (!HA_TOKEN) return "Home Assistant Token is not configured.";
  try {
    const res = await fetch(`${HA_URL}/api/states`, {
      headers: { 'Authorization': `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return `HA Error: ${res.status}`;
    const data = await res.json();
    const importantEntities = data.filter(e => 
      e.entity_id.startsWith('light.') || e.entity_id.startsWith('switch.') || e.entity_id.startsWith('climate.')
    ).map(e => `${e.entity_id}: ${e.state}`).join(', ');
    return `HA State:\n${importantEntities || 'No important entities found.'}`;
  } catch (err) {
    return `HA Fetch Error: ${err.message}`;
  }
}

// Helper: Fetch Mikrotik telemtry
async function getMikrotikState() {
  try {
    const auth = Buffer.from(`${MIKROTIK_USER}:${MIKROTIK_PASS}`).toString('base64');
    const res = await fetch(`${MIKROTIK_URL}/system/resource`, {
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return `Mikrotik Error: ${res.status}`;
    const data = await res.json();
    return `Mikrotik System: CPU ${data['cpu-load']}%, Free Memory ${(data['free-memory'] / 1024 / 1024).toFixed(1)}MB`;
  } catch (err) {
    return `Mikrotik Fetch Error: ${err.message}`;
  }
}

// Helper: list AGY sessions
async function getSessions() {
  try {
    await fsp.access(BRAIN_DIR);
  } catch {
    return [];
  }
  
  const dirs = await fsp.readdir(BRAIN_DIR, { withFileTypes: true });
  const validDirs = dirs.filter(d => d.isDirectory() && !d.name.startsWith('.'));

  const sessions = [];

  for (const d of validDirs) {
    const sessionDir = path.join(BRAIN_DIR, d.name);
    const transcriptPath = path.join(sessionDir, '.system_generated', 'logs', 'transcript.jsonl');
    
    try {
      await fsp.access(transcriptPath);
    } catch {
      continue;
    }

    const stat = await fsp.stat(transcriptPath);
    const firstLine = await getFirstLine(transcriptPath);
    let title = 'Sesi Tanpa Judul';

    if (firstLine) {
      try {
        const parsed = JSON.parse(firstLine);
        const content = parsed.content || '';
        const match = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
        if (match) {
          title = match[1].trim().replace(/\r?\n/g, ' ').slice(0, 90);
        } else {
          title = content.replace(/\r?\n/g, ' ').slice(0, 90);
        }
      } catch (err) {}
    }

    sessions.push({
      id: d.name,
      title: title || 'Sesi Antigravity',
      isCurrent: d.name === CURRENT_CONV_ID,
      updatedAt: stat.mtime
    });
  }

  sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return sessions.slice(0, 10);
}

// Persona prompts for local Ollama
const PERSONA_PROMPTS = {
  vibe_coding: "Anda adalah Aegis Pair-Programmer (Vibe Coding Mode). Anda senior systems architect, ahli Node.js, MikroTik, Linux, dan Python. Jawab solutif, ringkas, to the point dalam bahasa Indonesia (maksimal 3-4 kalimat).",
  devops: "Anda adalah Aegis DevOps & SRE. Anda menguasai Docker, RouterOS 6.49, firewall, latency tuning, dan telemetri sistem. Berikan analisis cepat dan tepat (maksimal 3-4 kalimat).",
  hermes_pro: "Anda adalah Hermes Pro Sovereign AI. Anda asisten otonom yang cerdas, fleksibel, berpikiran strategis, dan ramah seperti di Telegram. Jawab secara natural dan tajam.",
  homelab: "Anda adalah Aegis Homelab Assistant. Bantu kelola perangkat pintar, multimedia TV, dan PC secara ringkas dan ramah."
};

const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // 1. HEALTH CHECK
  if ((pathname === '/' || pathname === '/health' || pathname === '/api/health') && req.method === 'GET') {
    return sendJSON(res, 200, {
      status: 'ok',
      service: 'aegis-pc-bridge',
      pc: 'online',
      uptime: Math.round(process.uptime()),
      timestamp: Date.now()
    });
  }

  // 2. OPEN URL / APP ON WINDOWS DESKTOP
  if ((pathname === '/open' || pathname === '/api/open') && req.method === 'POST') {
    const body = await parseBody(req);
    let target = (body.url || body.target || '').trim();
    if (!target) {
      target = 'https://www.google.com';
    }

    if (!/^https?:\/\//i.test(target) && (target.includes('.com') || target.includes('.org') || target.includes('.net') || target.includes('.io') || target.includes('google') || target.includes('youtube'))) {
      target = 'https://' + target;
    }

    try {
      const parsedUrl = new URL(target);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return sendJSON(res, 400, { ok: false, error: 'Hanya protokol HTTP/HTTPS yang diizinkan.' });
      }

      console.log(`[PC-BRIDGE] Opening target on desktop: ${parsedUrl.href}`);
      const child = spawn('cmd.exe', ['/c', 'start', '""', parsedUrl.href], { windowsHide: true });
      activeChildren.add(child);
      
      child.on('close', (code) => {
        activeChildren.delete(child);
        if (code !== 0) return sendJSON(res, 500, { ok: false, error: 'Gagal mengeksekusi Start-Process' });
        return sendJSON(res, 200, { ok: true, message: `Berhasil membuka URL.` });
      });
    } catch (err) {
      return sendJSON(res, 400, { ok: false, error: 'Format URL tidak valid.' });
    }
    return;
  }

  // 3. GET AGY SESSIONS
  if ((pathname === '/sessions' || pathname === '/api/sessions') && req.method === 'GET') {
    try {
      const sessions = await getSessions();
      return sendJSON(res, 200, { ok: true, count: sessions.length, sessions });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // 4. RUN VIBE CODING PROMPT VIA AGY
  if ((pathname === '/vibe' || pathname === '/api/vibe') && req.method === 'POST') {
    const body = await parseBody(req);
    const prompt = (body.prompt || '').trim();
    const conversationId = (body.conversationId || '').trim();

    if (!prompt) {
      return sendJSON(res, 400, { ok: false, error: 'Prompt tidak boleh kosong.' });
    }

    if (conversationId && !/^[a-zA-Z0-9\-]+$/.test(conversationId)) {
      return sendJSON(res, 400, { ok: false, error: 'Format Conversation ID tidak valid.' });
    }

    console.log(`[PC-BRIDGE] Executing AGY prompt: "${prompt}" (conv: ${conversationId || 'current'})`);

    const args = [];
    if (conversationId) {
      args.push('--conversation', conversationId);
    } else {
      args.push('--continue');
    }
    args.push('--print', prompt);

    const child = spawn(AGY_BIN, args, {
      windowsHide: true,
      env: { ...process.env }
    });

    activeChildren.add(child);

    let stdout = '';
    let stderr = '';
    const MAX_BUFFER = 1024 * 1024; // 1MB cap

    child.stdout.on('data', chunk => {
      if (stdout.length < MAX_BUFFER) stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      if (stderr.length < MAX_BUFFER) stderr += chunk;
    });

    // Set 45s execution limit
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      console.warn('[PC-BRIDGE] AGY execution timed out');
    }, 45000);

    child.on('close', (code) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      const output = stdout.trim() || stderr.trim() || 'Perintah selesai dieksekusi oleh Antigravity.';
      return sendJSON(res, 200, {
        ok: code === 0,
        code,
        output,
        conversationId: conversationId || CURRENT_CONV_ID
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      return sendJSON(res, 500, { ok: false, error: err.message });
    });

    return;
  }

  // 5. LOCAL OLLAMA CHAT (ZERO API KEY POPUP)
  if ((pathname === '/chat' || pathname === '/api/chat') && req.method === 'POST') {
    const body = await parseBody(req);
    const rawPrompt = (body.prompt || '').trim();
    const mode = body.mode || 'vibe_coding';

    if (!rawPrompt) {
      return sendJSON(res, 400, { ok: false, error: 'Prompt kosong.' });
    }

    const persona = PERSONA_PROMPTS[mode] || PERSONA_PROMPTS.vibe_coding;
    const fullPrompt = `${persona}\n\nUser: ${rawPrompt}\nAssistant:`;

    try {
      const ollamaRes = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemma3:1b-it-qat',
          prompt: fullPrompt,
          stream: false
        })
      });

      if (!ollamaRes.ok) {
        throw new Error(`Ollama returned status ${ollamaRes.status}`);
      }

      const ollamaData = await ollamaRes.json();
      return sendJSON(res, 200, {
        ok: true,
        response: (ollamaData.response || '').trim(),
        model: 'gemma3:1b-it-qat'
      });
    } catch (err) {
      console.warn('[PC-BRIDGE] Ollama error:', err.message);
      return sendJSON(res, 200, {
        ok: true,
        response: `AegisBrain menerima instruksi: "${rawPrompt}". Subroutine sedang diproses.`,
        model: 'fallback'
      });
    }
  }

// Default 404
  sendJSON(res, 404, { ok: false, error: 'Endpoint tidak ditemukan.' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[PC-BRIDGE] Daemon listening on http://0.0.0.0:${PORT}`);
});

// Graceful Shutdown Handler
function gracefulShutdown() {
  console.log('\n[PC-BRIDGE] Shutting down gracefully...');
  for (const child of activeChildren) {
    try { child.kill('SIGTERM'); } catch (e) {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000); // force exit if hanging
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
