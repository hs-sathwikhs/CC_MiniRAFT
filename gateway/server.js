const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = parseInt(process.env.GATEWAY_PORT || '3000');
const REPLICAS = (process.env.REPLICA_URLS || 'http://replica1:4001,http://replica2:4002,http://replica3:4003').split(',');

// ── State ───────────────────────────────────────────────────────────
const clients = new Set();
let currentLeader = null;
const seenCommits = new Set();

// Metrics for dashboard
const metrics = {
  strokesForwarded: 0,
  strokesCommitted: 0,
  failedOps: 0,
  totalBroadcasts: 0,
  totalMessages: 0,
};

// Event log for dashboard
const eventLog = [];
function addLog(msg, type = 'info') {
  eventLog.unshift({ time: new Date().toISOString(), msg, type });
  if (eventLog.length > 200) eventLog.length = 200;
}

// Stroke batch queue
let strokeQueue = [];
let flushTimer = null;
const BATCH_SIZE = 64;
const FLUSH_MS = 12;

// ── Leader discovery ────────────────────────────────────────────────
async function findLeader() {
  for (const url of REPLICAS) {
    try {
      const r = await axios.get(`${url}/status`, { timeout: 1200 });
      if (r.data.role === 'leader') {
        console.log(`Leader found: ${url} term=${r.data.term}`);
        return url;
      }
      if (r.data.leader_id) {
        const match = REPLICAS.find(u => u.includes(r.data.leader_id));
        if (match) return match;
      }
    } catch {}
  }
  return null;
}

async function getLeader() {
  if (currentLeader) return currentLeader;
  for (let i = 0; i < 6; i++) {
    const leader = await findLeader();
    if (leader) { currentLeader = leader; return leader; }
    console.log(`No leader yet (${i + 1}/6)`);
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

// ── Broadcast to WebSocket clients ──────────────────────────────────
function broadcast(msg) {
  const data = JSON.stringify(msg);
  const dead = [];
  for (const ws of clients) {
    try { ws.send(data); } catch { dead.push(ws); }
  }
  dead.forEach(ws => clients.delete(ws));
  metrics.totalBroadcasts++;
}

// ── Stroke forwarding ──────────────────────────────────────────────
async function forwardStrokes(strokes) {
  if (!strokes.length) return true;

  for (let attempt = 0; attempt < 4; attempt++) {
    const leader = await getLeader();
    if (!leader) { metrics.failedOps++; addLog('No leader - strokes dropped', 'error'); return false; }

    try {
      const r = await axios.post(`${leader}/strokes`, { strokes }, {
        timeout: 2000, validateStatus: s => s === 200 || s === 307,
      });

      if (r.status === 200) {
        metrics.strokesForwarded += strokes.length;
        return true;
      }
      if (r.status === 307) {
        const hint = r.data;
        if (hint && hint.leader_id) {
          currentLeader = REPLICAS.find(u => u.includes(hint.leader_id)) || null;
        } else { currentLeader = null; }
      }
    } catch {
      currentLeader = null;
    }
    await new Promise(r => setTimeout(r, 50));
  }

  metrics.failedOps++;
  addLog(`Stroke batch dropped after 4 retries`, 'error');
  return false;
}

function queueStroke(stroke) {
  strokeQueue.push(stroke);
  if (!flushTimer) {
    flushTimer = setTimeout(flushQueue, FLUSH_MS);
  }
}

async function flushQueue() {
  flushTimer = null;
  if (!strokeQueue.length) return;
  const batch = strokeQueue;
  strokeQueue = [];
  const ok = await forwardStrokes(batch);
  if (!ok) console.log(`Dropped stroke batch size=${batch.length}`);
}

// ── Health check loop ───────────────────────────────────────────────
setInterval(async () => {
  if (!currentLeader) return;
  try {
    const r = await axios.get(`${currentLeader}/status`, { timeout: 1200 });
    if (r.data.role !== 'leader') {
      addLog('Leader health check failed - clearing', 'warn');
      currentLeader = null;
    }
  } catch {
    addLog('Leader unreachable - clearing', 'warn');
    currentLeader = null;
  }
}, 2000);

// Warm-up leader discovery on start
setTimeout(() => getLeader(), 1000);

// ── REST endpoints ──────────────────────────────────────────────────

// Receive single committed entry from leader
app.post('/commit', (req, res) => {
  const { index, term, data } = req.body;
  if (seenCommits.has(index)) return res.json({ ok: true, deduped: 1 });
  seenCommits.add(index);

  if (data && data.type === 'clear') {
    broadcast({ type: 'clear' });
  } else {
    broadcast({ type: 'stroke', stroke: data });
  }
  metrics.strokesCommitted++;
  addLog(`Committed index=${index}`, 'commit');
  res.json({ ok: true });
});

// Receive batch of committed entries from leader
app.post('/commit-batch', (req, res) => {
  const entries = req.body.entries || [];
  if (!entries.length) return res.json({ ok: true, count: 0 });

  let deduped = 0;
  const fresh = [];
  for (const e of entries) {
    if (seenCommits.has(e.index)) { deduped++; continue; }
    seenCommits.add(e.index);
    fresh.push(e);
  }
  if (!fresh.length) return res.json({ ok: true, count: 0, deduped });

  // Batch broadcast: group strokes, flush on clear
  const buf = [];
  for (const e of fresh) {
    if (e.data && e.data.type === 'clear') {
      if (buf.length) { broadcast({ type: 'strokes', strokes: [...buf] }); buf.length = 0; }
      broadcast({ type: 'clear' });
    } else {
      buf.push(e.data);
    }
  }
  if (buf.length) broadcast({ type: 'strokes', strokes: buf });

  metrics.strokesCommitted += fresh.length;
  addLog(`Committed batch count=${fresh.length} upto=${fresh[fresh.length - 1].index} deduped=${deduped}`, 'commit');
  res.json({ ok: true, count: fresh.length, deduped });
});

// Newly elected leader registers itself
app.post('/notify-leader', (req, res) => {
  const { leader_id, leader_url, term } = req.body;
  console.log(`New leader: ${leader_id} term=${term}`);

  const match = REPLICAS.find(u => u.split('//')[1].split(':')[0] === leader_id);
  currentLeader = match || leader_url;
  console.log(`Leader URL: ${currentLeader}`);

  addLog(`New leader: ${leader_id} term=${term}`, 'election');
  broadcast({ type: 'leader_change', leader_id, term });
  res.json({ ok: true });
});

// Broadcast canvas clear
app.post('/clear', (req, res) => {
  broadcast({ type: 'clear' });
  res.json({ ok: true });
});

// Gateway status
app.get('/status', async (req, res) => {
  let leaderTerm = null;
  if (currentLeader) {
    try {
      const r = await axios.get(`${currentLeader}/status`, { timeout: 1200 });
      leaderTerm = r.data.term;
    } catch {}
  }
  res.json({
    current_leader: currentLeader,
    connected_clients: clients.size,
    pending_strokes: strokeQueue.length,
    replicas: REPLICAS,
    term: leaderTerm,
  });
});

// Dashboard data endpoint - aggregates all cluster info
app.get('/dashboard-data', async (req, res) => {
  const replicaStatus = await Promise.allSettled(
    REPLICAS.map(async url => {
      const r = await axios.get(`${url}/status`, { timeout: 800 });
      return { url, ...r.data, online: true };
    })
  );

  const replicas = replicaStatus.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      url: REPLICAS[i],
      id: REPLICAS[i].split('//')[1].split(':')[0],
      online: false, role: 'unknown', term: 0,
      log_length: 0, commit_index: -1,
    };
  });

  res.json({
    connectedClients: clients.size,
    currentLeader,
    metrics,
    replicas,
    pendingStrokes: strokeQueue.length,
    eventLog: eventLog.slice(0, 50),
  });
});

// ── WebSocket handling ──────────────────────────────────────────────
wss.on('connection', async (ws) => {
  clients.add(ws);
  console.log(`Client connected total=${clients.size}`);
  addLog(`Client connected (total=${clients.size})`, 'info');

  // Send current leader info
  const leader = await getLeader();
  if (leader) {
    const rid = leader.split('//')[1].split(':')[0];
    let leaderTerm = null;
    try {
      const r = await axios.get(`${leader}/status`, { timeout: 1200 });
      leaderTerm = r.data.term;
    } catch {}
    try { ws.send(JSON.stringify({ type: 'leader', leader_id: rid, term: leaderTerm })); } catch {}
  }

  // Replay committed log to new client
  if (leader) {
    try {
      const r = await axios.get(`${leader}/log`, { timeout: 2000 });
      ws.send(JSON.stringify({ type: 'full_log', log: r.data.log || [] }));
    } catch {}
  }

  ws.on('message', (raw) => {
    metrics.totalMessages++;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'stroke' && msg.stroke) {
      queueStroke(msg.stroke);
    } else if (msg.type === 'strokes' && msg.strokes) {
      msg.strokes.forEach(s => { if (s) queueStroke(s); });
    } else if (msg.type === 'clear') {
      getLeader().then(l => {
        if (l) axios.post(`${l}/clear`, {}, { timeout: 2000 }).catch(() => {});
      });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`Client disconnected total=${clients.size}`);
    addLog(`Client disconnected (total=${clients.size})`, 'info');
  });
});

// ── Start ───────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Gateway started on port ${PORT}`);
});
