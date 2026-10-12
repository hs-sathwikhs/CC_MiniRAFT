const express = require('express');
const axios = require('axios');
const { randomUUID } = require('node:crypto');

const app = express();
app.use(express.json({ limit: '256kb' }));
const rpc = axios.create({ timeout: 250, proxy: false });
const nodeId = process.env.REPLICA_ID || 'replica1';
const port = Number(process.env.PORT || 4001);
const peers = (process.env.PEERS || '').split(',').map(url => url.trim()).filter(Boolean);
const gatewayUrl = process.env.GATEWAY_URL || 'http://gateway:3000';
const majority = Math.floor((peers.length + 1) / 2) + 1;
const heartbeatMs = 150;

const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value);
const validInt = value => Number.isSafeInteger(value) && value >= -1;
const validStroke = stroke => stroke && typeof stroke === 'object'
  && ['x0', 'x1'].every(key => Number.isFinite(stroke[key]) && stroke[key] >= 0 && stroke[key] <= 1100)
  && ['y0', 'y1'].every(key => Number.isFinite(stroke[key]) && stroke[key] >= 0 && stroke[key] <= 680)
  && Number.isFinite(stroke.width) && stroke.width >= 1 && stroke.width <= 20
  && /^#[a-f0-9]{6}$/i.test(stroke.color) && ['draw', 'erase'].includes(stroke.tool)
  && validId(stroke.clientId) && validId(stroke.strokeId);
const validOp = data => validStroke(data) || (data?.type === 'clear' && validId(data.strokeId));
const validEntry = entry => entry && validInt(entry.term) && entry.term >= 0
  && (validOp(entry.data) || entry.data?.type === 'noop');
const peerUrl = id => peers.find(url => new URL(url).hostname === id);
const sameEntry = (a, b) => a.term === b.term && JSON.stringify(a.data) === JSON.stringify(b.data);

let role = 'follower';
let term = 0;
let votedFor = null;
let leaderId = null;
let raftLog = [];
let commitIndex = -1;
let nextIdx = {};
let matchIdx = {};
let heardAt = {};
let busy = new Set();
let syncing = false;
let electTimer;
let heartbeatTimer;

function resetElection() {
  clearTimeout(electTimer);
  if (role !== 'leader') electTimer = setTimeout(startElection, 500 + Math.random() * 300);
}

function stepDown(newTerm, leader = null) {
  if (newTerm < term) return;
  if (newTerm > term) { term = newTerm; votedFor = null; }
  role = 'follower';
  leaderId = leader;
  clearInterval(heartbeatTimer);
  resetElection();
}

function notifyGateway(route) {
  rpc.post(`${gatewayUrl}/${route}`, { leader_id: nodeId, term }).catch(() => {});
}

function promoteToLeader() {
  role = 'leader';
  leaderId = nodeId;
  clearTimeout(electTimer);
  nextIdx = Object.fromEntries(peers.map(peer => [peer, raftLog.length]));
  matchIdx = Object.fromEntries(peers.map(peer => [peer, -1]));
  heardAt = {};
  busy = new Set();
  // a current-term entry lets the new leader finish earlier pending commits.
  raftLog.push({ term, data: { type: 'noop' } });
  console.log(`leader ${nodeId} term=${term}`);
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(replicateAll, heartbeatMs);
  replicateAll();
  notifyGateway('notify-leader');
}

async function startElection() {
  if (role === 'leader') return;
  role = 'candidate';
  term++;
  votedFor = nodeId;
  leaderId = null;
  const electionTerm = term;
  let votes = 1;
  resetElection();
  console.log(`election ${nodeId} term=${term}`);
  if (votes >= majority) return promoteToLeader();
  await Promise.allSettled(peers.map(async peer => {
    try {
      const { data } = await rpc.post(`${peer}/request-vote`, {
        term: electionTerm, candidate_id: nodeId,
        last_log_index: raftLog.length - 1, last_log_term: raftLog.at(-1)?.term ?? -1,
      });
      if (data.term > term) return stepDown(data.term);
      if (role !== 'candidate' || term !== electionTerm || data.term !== term) return;
      if (data.vote_granted && ++votes >= majority) promoteToLeader();
    } catch {}
  }));
}

function replicateAll() {
  if (role !== 'leader') return;
  peers.forEach(replicateTo);
  advanceCommit();
}

async function replicateTo(peer) {
  const pending = busy;
  if (role !== 'leader' || pending.has(peer)) return;
  pending.add(peer);
  const requestTerm = term;
  const from = nextIdx[peer];
  const entries = raftLog.slice(from, from + 64);
  try {
    const { data } = await rpc.post(`${peer}/append-entries`, {
      term: requestTerm, leader_id: nodeId,
      prev_log_index: from - 1, prev_log_term: raftLog[from - 1]?.term ?? -1,
      entries, leader_commit: commitIndex,
    });
    if (data.term > term) return stepDown(data.term);
    if (role !== 'leader' || term !== requestTerm || data.term !== term) return;
    if (data.success) {
      heardAt[peer] = Date.now();
      matchIdx[peer] = from + entries.length - 1;
      nextIdx[peer] = from + entries.length;
      advanceCommit();
    } else {
      nextIdx[peer] = Math.max(0, Math.min(from - 1, data.conflict_index ?? from - 1));
    }
  } catch {} finally { pending.delete(peer); }
}

function advanceCommit() {
  if (role !== 'leader') return;
  const indexes = [raftLog.length - 1, ...peers.map(peer => matchIdx[peer] ?? -1)].sort((a, b) => b - a);
  const next = indexes[majority - 1];
  if (next > commitIndex && raftLog[next]?.term === term) {
    commitIndex = next;
    console.log(`commit ${nodeId} index=${commitIndex} term=${term}`);
    notifyGateway('commit-batch');
  }
}

async function syncFromLeader(id, requestTerm) {
  const url = peerUrl(id);
  if (syncing || !url) return;
  syncing = true;
  const from = commitIndex + 1;
  try {
    const { data } = await rpc.post(`${url}/sync-log`, {
      from_index: from, prev_log_term: raftLog[from - 1]?.term ?? -1,
    });
    // ignore a reply if an election or another append changed its starting point.
    if (role !== 'follower' || term !== requestTerm || leaderId !== id
      || data.term !== term || data.from_index !== from || commitIndex + 1 !== from) return;
    if (!Array.isArray(data.entries) || !data.entries.every(validEntry) || from + data.entries.length - 1 > data.commit_index) return;
    if (data.entries.length) {
      raftLog.splice(from, raftLog.length - from, ...data.entries);
      commitIndex = from + data.entries.length - 1;
      console.log(`catch-up ${nodeId} entries=${data.entries.length} commit=${commitIndex}`);
    }
  } catch {} finally { syncing = false; }
}

app.get('/status', (req, res) => res.json({
  id: nodeId, role, term, leader_id: leaderId, log_length: raftLog.length,
  commit_index: commitIndex, last_applied: commitIndex, peers,
  hasQuorum: role === 'leader' && 1 + peers.filter(peer => Date.now() - (heardAt[peer] || 0) < 500).length >= majority,
}));

app.get('/log', (req, res) => {
  const committed = raftLog.slice(0, commitIndex + 1).map(entry => entry.data);
  const lastClear = committed.findLastIndex(data => data.type === 'clear');
  res.json({ log: committed.slice(lastClear + 1).filter(data => data.type !== 'noop') });
});

function appendStrokes(strokes, res) {
  if (!Array.isArray(strokes) || !strokes.length || strokes.length > 64 || !strokes.every(validOp)) return res.status(400).json({ error: 'invalid stroke batch' });
  if (role !== 'leader') return res.status(307).json({ error: 'not_leader', leader_id: leaderId });
  const from = raftLog.length;
  strokes.forEach(data => raftLog.push({ term, data }));
  replicateAll();
  res.json({ ok: true, from_index: from, to_index: raftLog.length - 1 });
}

app.post('/stroke', (req, res) => appendStrokes([req.body], res));
app.post('/strokes', (req, res) => appendStrokes(req.body.strokes, res));
app.post('/clear', (req, res) => appendStrokes([{ type: 'clear', strokeId: randomUUID() }], res));

function appendEntries(req, res) {
  const { term: requestTerm, leader_id: id, prev_log_index: prevIdx,
    prev_log_term: prevTerm, entries = [], leader_commit: leaderCommit } = req.body;
  if (![requestTerm, prevIdx, prevTerm, leaderCommit].every(validInt) || requestTerm < 0
    || !peerUrl(id) || !Array.isArray(entries) || entries.length > 64
    || !entries.every(entry => validEntry(entry) && entry.term <= requestTerm)
    || (prevIdx === -1 && prevTerm !== -1)) return res.status(400).json({ error: 'invalid append request' });
  if (requestTerm < term) return res.json({ term, success: false });
  stepDown(requestTerm, id);
  if (prevIdx >= raftLog.length) {
    syncFromLeader(id, requestTerm);
    return res.json({ term, success: false, conflict_index: raftLog.length });
  }
  if (prevIdx >= 0 && raftLog[prevIdx].term !== prevTerm) {
    let idx = prevIdx;
    while (idx > 0 && raftLog[idx - 1].term === raftLog[prevIdx].term) idx--;
    return res.json({ term, success: false, conflict_index: idx });
  }
  for (let idx = 0; idx < entries.length; idx++) {
    const at = prevIdx + 1 + idx;
    if (at <= commitIndex && !sameEntry(raftLog[at], entries[idx])) return res.json({ term, success: false, conflict_index: commitIndex + 1 });
  }
  for (let idx = 0; idx < entries.length; idx++) {
    const at = prevIdx + 1 + idx;
    if (at < raftLog.length && !sameEntry(raftLog[at], entries[idx])) raftLog.splice(at);
    if (at === raftLog.length) raftLog.push(entries[idx]);
  }
  // an empty heartbeat only confirms the prefix it actually matched.
  commitIndex = Math.max(commitIndex, Math.min(leaderCommit, prevIdx + entries.length));
  res.json({ term, success: true });
}

app.post('/append-entries', appendEntries);
app.post('/heartbeat', appendEntries);

app.post('/request-vote', (req, res) => {
  const { term: requestTerm, candidate_id: id, last_log_index: lastIdx, last_log_term: lastTerm } = req.body;
  if (![requestTerm, lastIdx, lastTerm].every(validInt) || requestTerm < 0 || !peerUrl(id)) return res.status(400).json({ error: 'invalid vote request' });
  if (requestTerm < term) return res.json({ term, vote_granted: false });
  if (requestTerm > term) stepDown(requestTerm);
  const myTerm = raftLog.at(-1)?.term ?? -1;
  const logOk = lastTerm > myTerm || (lastTerm === myTerm && lastIdx >= raftLog.length - 1);
  const granted = logOk && (votedFor === null || votedFor === id);
  if (granted) { votedFor = id; resetElection(); }
  res.json({ term, vote_granted: granted });
});

app.post('/sync-log', (req, res) => {
  const from = req.body.from_index;
  if (!validInt(from) || from < 0) return res.status(400).json({ error: 'invalid log index' });
  if (role !== 'leader') return res.status(307).json({ error: 'not_leader', leader_id: leaderId });
  if (req.body.prev_log_term !== undefined && req.body.prev_log_term !== (raftLog[from - 1]?.term ?? -1)) return res.status(409).json({ error: 'log prefix differs' });
  res.json({ term, leader_id: nodeId, from_index: from, commit_index: commitIndex,
    entries: raftLog.slice(from, Math.min(commitIndex + 1, from + 64)) });
});

app.use((err, req, res, next) => res.status(err.status || 500).json({ error: 'request could not be processed' }));
const server = app.listen(port, '0.0.0.0', () => { console.log(`replica ${nodeId} port=${port}`); resetElection(); });
process.on('SIGTERM', () => {
  clearTimeout(electTimer);
  clearInterval(heartbeatTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
