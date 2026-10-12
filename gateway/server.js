const express = require('express');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '256kb' }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 65536 });
const rpc = axios.create({ timeout: 400, proxy: false });
const port = Number(process.env.GATEWAY_PORT || 3000);
const replicaUrls = (process.env.REPLICA_URLS || 'http://replica1:4001,http://replica2:4002,http://replica3:4003').split(',').map(url => url.trim());
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value);
const validStroke = stroke => stroke && typeof stroke === 'object'
  && ['x0', 'x1'].every(key => Number.isFinite(stroke[key]) && stroke[key] >= 0 && stroke[key] <= 1100)
  && ['y0', 'y1'].every(key => Number.isFinite(stroke[key]) && stroke[key] >= 0 && stroke[key] <= 680)
  && Number.isFinite(stroke.width) && stroke.width >= 1 && stroke.width <= 20
  && /^#[a-f0-9]{6}$/i.test(stroke.color) && ['draw', 'erase'].includes(stroke.tool)
  && validId(stroke.clientId) && validId(stroke.strokeId);

const clients = new Set();
const eventLog = [];
const metrics = { strokesForwarded: 0, strokesCommitted: 0, failedOps: 0, totalBroadcasts: 0, totalMessages: 0 };
let currentLeader = null;
let leaderTerm = 0;
let replicas = [];
let boardLog = [];
let lastIndex = -1;
let refreshing = null;
let syncing = false;
let sending = false;
let flushTimer;
let strokeQueue = [];

function addLog(msg, type = 'info') {
  eventLog.unshift({ time: new Date().toISOString(), msg, type });
  if (eventLog.length > 50) eventLog.pop();
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  for (const ws of clients) if (ws.ready) send(ws, msg);
  metrics.totalBroadcasts++;
}

function refreshCluster() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    replicas = await Promise.all(replicaUrls.map(async url => {
      try { return { ...(await rpc.get(`${url}/status`)).data, url, online: true }; }
      catch { return { id: new URL(url).hostname, url, online: false, role: 'offline', term: null, log_length: null, commit_index: null }; }
    }));
    const leader = replicas.filter(node => node.role === 'leader').sort((a, b) => b.term - a.term)[0];
    const nextUrl = leader?.url || null;
    if (currentLeader !== nextUrl || (leader && leader.term !== leaderTerm)) {
      currentLeader = nextUrl;
      if (leader) leaderTerm = leader.term;
      addLog(leader ? `${leader.id} elected in term ${leader.term}` : 'Waiting for a leader', 'election');
      broadcast({ type: 'leader_change', leader_id: leader?.id || null, term: leader?.term || null });
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

async function syncCommits() {
  if (syncing || !currentLeader) return;
  syncing = true;
  const leader = currentLeader;
  try {
    const { data } = await rpc.post(`${leader}/sync-log`, { from_index: lastIndex + 1 });
    if (leader !== currentLeader || data.term < leaderTerm || data.from_index !== lastIndex + 1) return;
    for (const entry of data.entries) {
      lastIndex++;
      const op = entry.data;
      if (op.type === 'noop') continue;
      if (op.type === 'clear') {
        boardLog = [];
        broadcast({ type: 'clear', strokeId: op.strokeId });
      } else {
        boardLog.push(op);
        broadcast({ type: 'stroke', stroke: op });
      }
      metrics.strokesCommitted++;
    }
    if (data.entries.length) addLog(`Applied entries through ${lastIndex}`, 'commit');
    if (lastIndex < data.commit_index) setImmediate(syncCommits);
  } catch {
    if (leader === currentLeader) currentLeader = null;
  } finally { syncing = false; }
}

async function forwardStrokes(strokes) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!currentLeader) await refreshCluster();
    if (currentLeader) {
      try {
        await rpc.post(`${currentLeader}/strokes`, { strokes });
        metrics.strokesForwarded += strokes.length;
        return true;
      } catch { currentLeader = null; }
    }
    await new Promise(res => setTimeout(res, 100));
  }
  metrics.failedOps++;
  return false;
}

function queueStroke(stroke) {
  strokeQueue.push(stroke);
  if (!flushTimer) flushTimer = setTimeout(flushQueue, 12);
}

async function flushQueue() {
  flushTimer = null;
  if (sending || !strokeQueue.length) return;
  sending = true;
  const batch = strokeQueue.splice(0, 64);
  try {
    if (!await forwardStrokes(batch)) broadcast({ type: 'error', error: 'drawing could not be sent' });
  } finally {
    sending = false;
    if (strokeQueue.length) flushTimer = setTimeout(flushQueue, 12);
  }
}

function leaderHint(req, res) {
  const { leader_id: id, term } = req.body;
  if (!replicaUrls.some(url => new URL(url).hostname === id) || !Number.isSafeInteger(term) || term < 0) return res.status(400).json({ error: 'invalid leader' });
  refreshCluster().then(syncCommits);
  res.json({ ok: true });
}

// hints trigger a read from the leader; their bodies never become board entries.
app.post('/notify-leader', leaderHint);
app.post('/commit-batch', leaderHint);
app.post('/clear', (req, res) => {
  if (strokeQueue.length >= 4096) return res.status(503).json({ error: 'drawing queue is full' });
  queueStroke({ type: 'clear', strokeId: randomUUID() });
  res.status(202).json({ ok: true });
});
app.get('/status', (req, res) => res.json({
  current_leader: currentLeader, connected_clients: clients.size, pending_strokes: strokeQueue.length,
  replicas: replicaUrls, term: currentLeader ? leaderTerm : null,
}));
app.get('/dashboard-data', (req, res) => res.json({
  connectedClients: clients.size, currentLeader, metrics, replicas,
  pendingStrokes: strokeQueue.length, eventLog,
}));

wss.on('connection', async ws => {
  ws.ready = false;
  clients.add(ws);
  ws.on('error', () => clients.delete(ws));
  ws.on('close', () => clients.delete(ws));
  ws.on('message', raw => {
    metrics.totalMessages++;
    const fail = error => send(ws, { type: 'error', error });
    let msg;
    try { msg = JSON.parse(raw); } catch { return fail('invalid JSON'); }
    if (!msg || typeof msg !== 'object') return fail('invalid drawing message');
    if (msg.type === 'clear') {
      if (strokeQueue.length >= 4096) return fail('drawing queue is full');
      return queueStroke({ type: 'clear', strokeId: randomUUID() });
    }
    const strokes = msg.type === 'stroke' ? [msg.stroke] : msg.type === 'strokes' ? msg.strokes : null;
    if (!Array.isArray(strokes) || !strokes.length || strokes.length > 64 || !strokes.every(validStroke)) return fail('invalid stroke batch');
    if (strokeQueue.length + strokes.length > 4096) return fail('drawing queue is full');
    strokes.forEach(queueStroke);
  });
  await refreshCluster();
  await syncCommits();
  send(ws, { type: 'full_log', log: boardLog });
  send(ws, { type: 'leader', leader_id: currentLeader ? new URL(currentLeader).hostname : null, term: currentLeader ? leaderTerm : null });
  ws.ready = true;
});

const clusterTimer = setInterval(() => refreshCluster().then(syncCommits), 400);
const commitTimer = setInterval(syncCommits, 150);
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: 'request could not be processed' }));
server.listen(port, '0.0.0.0', () => { console.log(`gateway port=${port}`); refreshCluster(); });
process.on('SIGTERM', () => {
  clearInterval(clusterTimer);
  clearInterval(commitTimer);
  clearTimeout(flushTimer);
  for (const ws of clients) ws.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
