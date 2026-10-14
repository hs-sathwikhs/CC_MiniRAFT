const express = require('express');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const axios = require('axios');
const { isDeepStrictEqual } = require('node:util');

const app = express();
app.use(express.json({ limit: '256kb' }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 65536 });
const rpc = axios.create({ timeout: 400, proxy: false });
const port = Number(process.env.GATEWAY_PORT || 3000);
const replicaUrls = (process.env.REPLICA_URLS || 'http://replica1:4001,http://replica2:4002,http://replica3:4003').split(',').map(url => url.trim());
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value);
const validStroke = stroke => stroke && typeof stroke === 'object' && stroke.type === undefined
  && ['x0', 'x1'].every(key => Number.isFinite(stroke[key]) && stroke[key] >= 0 && stroke[key] <= 1100)
  && ['y0', 'y1'].every(key => Number.isFinite(stroke[key]) && stroke[key] >= 0 && stroke[key] <= 680)
  && Number.isFinite(stroke.width) && stroke.width >= 1 && stroke.width <= 20
  && /^#[a-f0-9]{6}$/i.test(stroke.color) && ['draw', 'erase'].includes(stroke.tool)
  && validId(stroke.clientId) && validId(stroke.strokeId)
  && (stroke.drawId === undefined || validId(stroke.drawId));

const validOp = op => validStroke(op) || (op && validId(op.strokeId)
  && ((op.type === 'clear' && (op.clientId === undefined || validId(op.clientId)))
    || (['undo', 'redo'].includes(op.type) && validId(op.clientId) && validId(op.drawId))));

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
let retryAt = 0;
const pendingOps = new Map();
const committedOps = new Map();
const opKey = op => `${op.clientId || 'legacy'}:${op.strokeId}`;

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
      const key = opKey(op);
      committedOps.set(key, { op, index: lastIndex });
      for (const ws of pendingOps.get(key)?.clients || []) acknowledge(ws, op, lastIndex);
      pendingOps.delete(key);
      retryAt = 0;
      if (op.type === 'clear') {
        boardLog = [];
        broadcast({ type: 'clear', ...op });
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

function acknowledge(ws, op, index) {
  send(ws, { type: 'ack', clientId: op.clientId, strokeId: op.strokeId, index });
}

function queueStrokes(strokes, ws) {
  const batch = new Map();
  for (const op of strokes) {
    const key = opKey(op);
    const prev = batch.get(key) || pendingOps.get(key)?.op || committedOps.get(key)?.op;
    if (prev && !isDeepStrictEqual(prev, op)) return 'operation id already used';
    batch.set(key, op);
  }
  const fresh = [...batch.keys()].filter(key => !pendingOps.has(key) && !committedOps.has(key));
  if (pendingOps.size + fresh.length > 4096) return 'drawing queue is full';
  for (const [key, op] of batch) {
    const committed = committedOps.get(key);
    if (committed) { if (ws) acknowledge(ws, op, committed.index); continue; }
    if (!pendingOps.has(key)) pendingOps.set(key, { op, since: Date.now(), clients: new Set() });
    if (ws) {
      pendingOps.get(key).clients.add(ws);
      send(ws, { type: 'pending', strokeId: op.strokeId, clientId: op.clientId });
    }
  }
  return null;
}

async function flushQueue() {
  for (const [key, item] of pendingOps) {
    if (Date.now() - item.since < 15000) continue;
    for (const ws of item.clients) send(ws, { type: 'unconfirmed', strokeId: item.op.strokeId,
      clientId: item.op.clientId, error: 'No commit confirmed. Retry when the cluster is ready.' });
    pendingOps.delete(key);
    metrics.failedOps++;
  }
  if (sending || !pendingOps.size || Date.now() < retryAt) return;
  const leader = replicas.find(node => node.url === currentLeader && node.hasQuorum);
  if (!leader) return;
  sending = true;
  retryAt = Date.now() + 700;
  const strokes = [...pendingOps.values()].slice(0, 64).map(item => item.op);
  try {
    await rpc.post(`${leader.url}/strokes`, { strokes });
    metrics.strokesForwarded += strokes.length;
  } catch (err) {
    if (err.response?.status === 409) {
      for (const op of strokes) {
        const key = opKey(op);
        for (const ws of pendingOps.get(key)?.clients || []) send(ws, { type: 'error',
          strokeId: op.strokeId, clientId: op.clientId, error: 'operation id already used' });
        pendingOps.delete(key);
      }
    } else if (currentLeader === leader.url) currentLeader = null;
  } finally { sending = false; }
}

function clearOp(msg) {
  return { type: 'clear', clientId: msg?.clientId ?? 'legacy', strokeId: msg?.strokeId ?? randomUUID() };
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
  const op = clearOp(req.body);
  if (!validId(op.clientId) || !validId(op.strokeId)) return res.status(400).json({ error: 'invalid clear' });
  const error = queueStrokes([op]);
  if (error) return res.status(503).json({ error });
  res.status(202).json({ ok: true, ...op });
});
app.get('/status', (req, res) => res.json({
  current_leader: currentLeader, connected_clients: clients.size, pending_strokes: pendingOps.size,
  replicas: replicaUrls, term: currentLeader ? leaderTerm : null,
}));
app.get('/dashboard-data', (req, res) => res.json({
  connectedClients: clients.size, currentLeader, metrics, replicas,
  pendingStrokes: pendingOps.size, eventLog,
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
      const op = clearOp(msg);
      if (!validId(op.clientId) || !validId(op.strokeId)) return fail('invalid clear');
      const error = queueStrokes([op], ws);
      if (error) fail(error);
      return;
    }
    const strokes = msg.type === 'stroke' ? [msg.stroke] : ['strokes', 'ops'].includes(msg.type) ? msg.strokes : null;
    if (!Array.isArray(strokes) || !strokes.length || strokes.length > 64 || !strokes.every(validOp)) return fail('invalid stroke batch');
    const error = queueStrokes(strokes, ws);
    if (error) fail(error);
  });
  await refreshCluster();
  await syncCommits();
  send(ws, { type: 'full_log', log: boardLog });
  send(ws, { type: 'leader', leader_id: currentLeader ? new URL(currentLeader).hostname : null, term: currentLeader ? leaderTerm : null });
  ws.ready = true;
});

const clusterTimer = setInterval(() => refreshCluster().then(syncCommits), 400);
const commitTimer = setInterval(syncCommits, 150);
const flushTimer = setInterval(flushQueue, 25);
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: 'request could not be processed' }));
server.listen(port, '0.0.0.0', () => { console.log(`gateway port=${port}`); refreshCluster(); });
process.on('SIGTERM', () => {
  clearInterval(clusterTimer);
  clearInterval(commitTimer);
  clearInterval(flushTimer);
  for (const ws of clients) ws.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
