#!/usr/bin/env node
/**
 * auto-domain Agent
 * Usage: node agent.js --port=3000 [--name=myapp] [--auto-name]
 *                      [--server=wss://tunnel-api.chxyka.ccwu.cc]
 *                      [--tg-token=BOT_TOKEN] [--tg-chat=CHAT_ID]
 */

const WebSocket = require('ws');

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = {};
process.argv.slice(2).forEach(arg => {
  if (arg.startsWith('--')) {
    const eqIndex = arg.indexOf('=');
    if (eqIndex > -1) {
      args[arg.slice(2, eqIndex)] = arg.slice(eqIndex + 1);
    } else {
      args[arg.slice(2)] = true;
    }
  }
});

const PORT      = parseInt(args.port || args.p || '3000', 10);
const TOKEN     = args.token  || args.t || '';
const NAME      = args.name   || args.n || '';
const METADATA  = args.metadata || args.m || '';
const AUTO_NAME = args['auto-name'] === true || args['auto-name'] === '1' || args.auto === true || args.auto === '1';
const REPLACE   = args['replace'] === true || args['replace'] === '1';
const SERVER    = (args.server || 'wss://tunnel-api.chxyka.ccwu.cc').replace(/\/$/, '');
const TG_TOKEN  = args['tg-token'] || process.env.TG_BOT_TOKEN  || '';
const TG_CHAT   = args['tg-chat']  || process.env.TG_CHAT_ID    || '';
const LOCAL_HOST = process.env.AUTO_DOMAIN_LOCAL_HOST || '127.0.0.1';

const PING_INTERVAL_MS       = 30_000;               // 30s 心跳
const LOCAL_CHECK_INTERVAL_MS = 30_000;              // 30s 本地健康检查
const SELF_DESTRUCT_MS        = 24 * 60 * 60 * 1000; // 24h 无连接自毁

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendTg(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
    });
  } catch (_) {}
}

function tgMsg(emoji, title, fields) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const lines = [`${emoji} <b>${title}</b>`];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(`   ${k}: <code>${v}</code>`);
  }
  lines.push(`   Time: ${now}`);
  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let cachedIPv4 = '';
async function getPublicIPv4() {
  if (cachedIPv4) return cachedIPv4;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const resp = await fetch('https://ipv4.icanhazip.com', { signal: ctrl.signal });
    clearTimeout(t);
    cachedIPv4 = (await resp.text()).trim();
    return cachedIPv4;
  } catch {
    return '';
  }
}

function currentSubdomain() {
  return NAME || (tunnelUrl ? tunnelUrl.split('//')[1].split('.')[0] : '?');
}

function stopPing() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

function stopLocalCheck() {
  if (localCheckTimer) { clearInterval(localCheckTimer); localCheckTimer = null; }
}

function startPing(ws) {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      const currentOk = (localOk === true);
      console.log(`[auto-domain] Sending heartbeat ping (local_ok: ${currentOk})`);
      ws.send(JSON.stringify({ type: 'ping', local_ok: currentOk }));
    }
  }, PING_INTERVAL_MS);
}

async function checkLocalService() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    let resp = await fetch(`http://${LOCAL_HOST}:${PORT}/health`, { signal: ctrl.signal }).catch(() => null);
    if (!resp || !resp.ok) {
      resp = await fetch(`http://${LOCAL_HOST}:${PORT}/`, { signal: ctrl.signal }).catch(() => null);
    }
    clearTimeout(t);
    return !!(resp && (resp.ok || resp.status === 401 || resp.status === 403));
  } catch {
    return false;
  }
}

async function doLocalCheck(ws) {
  const ok = await checkLocalService();
  const prev = localOk;
  localOk = ok;

  if (prev !== null && ok !== prev) {
    if (ok) {
      console.log('[auto-domain] ✅ Local service recovered on port', PORT);
      sendTg(tgMsg('🟢', 'Local Service Recovered', {
        Port: String(PORT), Subdomain: currentSubdomain(),
      })).catch(() => {});
    } else {
      console.log('[auto-domain] ❌ Local service DOWN on port', PORT);
      sendTg(tgMsg('🔴', 'Local Service Down', {
        Port: String(PORT), Subdomain: currentSubdomain(),
      })).catch(() => {});
    }
  }

  if (ws && ws.readyState === WebSocket.OPEN && (prev === null || ok !== prev)) {
    console.log('[auto-domain] Reporting local status:', ok ? 'OK' : 'DOWN');
    ws.send(JSON.stringify({ type: 'ping', local_ok: ok }));
  }
}

function startLocalCheck(ws) {
  stopLocalCheck();
  doLocalCheck(ws);
  localCheckTimer = setInterval(() => doLocalCheck(ws), LOCAL_CHECK_INTERVAL_MS);
}

async function buildWsUrl() {
  let host = SERVER.replace(/^wss?:\/\//, '');
  // 如果指定了名字，则尝试直接连接到该子域名的 /websocket 路径
  // 这能确保 Agent 和网关请求命中同一个 Cloudflare Durable Object 实例
  if (NAME && !host.startsWith(NAME + '.')) {
    // 假设域名后缀是 .chxyka.ccwu.cc 或类似的
    const parts = host.split('.');
    if (parts.length >= 2) {
      const domainSuffix = parts.slice(-3).join('.'); // chxyka.ccwu.cc
      host = `${NAME}.${domainSuffix}`;
    }
  }

  const u = new URL(`wss://${host}/websocket`);
  if (TOKEN) u.searchParams.set('token', TOKEN);
  u.searchParams.set('port', String(PORT));
  if (NAME) u.searchParams.set('name', NAME);
  if (AUTO_NAME) u.searchParams.set('auto', '1');
  if (METADATA) u.searchParams.set('metadata', METADATA);
  if (REPLACE) u.searchParams.set('replace', '1');

  const ip = await getPublicIPv4();
  if (ip) u.searchParams.set('client_ip', ip);

  return u.toString();
}

// ── Connect ───────────────────────────────────────────────────────────────────

let reconnectDelay = 3000;
let pingTimer      = null;
let localCheckTimer = null;
let tunnelUrl      = '';
let subdomain      = '';
let failingSince   = null;
let replacing      = false;
let localOk        = null;   // null=unknown, true=ok, false=down

async function connect() {
  if (failingSince && Date.now() - failingSince > SELF_DESTRUCT_MS) {
    process.exit(1);
  }
  if (!failingSince) failingSince = Date.now();

  console.log('[auto-domain] Connecting...');
  const wsUrl = await buildWsUrl();
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    reconnectDelay = 3000;
    console.log('[auto-domain] Connected. Waiting for assignment...');
  });

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'pong') {
      console.log('[auto-domain] Received heartbeat pong');
      return;
    }

    if (msg.type === 'connected') {
      failingSince = null;
      tunnelUrl    = msg.url;
      subdomain    = msg.subdomain || currentSubdomain();
      console.log(`\n✅ Tunnel is live!\n   Public URL : ${tunnelUrl}\n   Forwarding : ${tunnelUrl} → http://${LOCAL_HOST}:${PORT}\n`);
      startPing(ws);
      startLocalCheck(ws);
    }

    if (msg.type === 'kill' || msg.type === 'destroy') {
      const isDestroy = msg.type === 'destroy';
      if (isDestroy) {
        try {
          const { execSync } = require('child_process');
          execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`);
          const unit = execSync('systemctl status $$ | grep ".service" | awk "{print $1}" | head -1').toString().trim();
          if (unit) execSync(`systemctl disable --now ${unit} 2>/dev/null || true`);
        } catch (_) {}
      }
      process.exit(0);
    }

    if (msg.type === 'request') {
      const { id, method, path, headers, body } = msg;
      try {
        const fetchHeaders = new Headers();
        for (const [k, v] of Object.entries(headers)) {
          if (!['host', 'connection', 'upgrade'].includes(k.toLowerCase())) fetchHeaders.set(k, v);
        }
        const requestBody = method !== 'GET' && method !== 'HEAD' && body
          ? Buffer.from(body, 'base64')
          : undefined;
        const resp = await fetch(`http://${LOCAL_HOST}:${PORT}${path}`, {
          method,
          headers: fetchHeaders,
          body: requestBody,
          redirect: 'manual'
        });
        const respBody = await resp.arrayBuffer();
        const respHeaders = {};
        resp.headers.forEach((v, k) => { respHeaders[k] = v; });
        ws.send(JSON.stringify({
          type: 'response', id, status: resp.status,
          headers: respHeaders, body: Buffer.from(respBody).toString('base64')
        }));
      } catch (err) {
        ws.send(JSON.stringify({
          type: 'response', id, status: 502,
          headers: { 'content-type': 'text/plain' },
          body: Buffer.from(`Local service error: ${err.message}`).toString('base64')
        }));
      }
    }
  });

  ws.on('close', (code, reason) => {
    stopPing();
    stopLocalCheck();
    if (code === 4001) process.exit(0);
    if (code === 4009 && REPLACE) {
      if (!replacing) {
        replacing = true;
        const evictUrl = wsUrl + '&replace=1';
        setTimeout(async () => {
          console.log(`[auto-domain] 409 detected — --replace mode: evicting old agent...`);
          const ws2 = new WebSocket(evictUrl);
          ws2.on('open', () => ws2.close(1000, 'Eviction triggered'));
          ws2.on('close', () => { replacing = false; connect(); });
        }, 1000);
      }
      return;
    }
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay + 5000, 30000);
  });

  ws.on('error', (err) => {
    console.error(`[auto-domain] WebSocket error: ${err.message}`);
  });
}

sendTg(tgMsg('▶️', 'Agent Starting', {
  Name: NAME || '(auto)',
  Port: String(PORT),
  Server: SERVER,
})).then(() => connect());
