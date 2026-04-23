const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// ── Config ──────────────────────────────────────────────────────────
const ID = process.env.REPLICA_ID || 'replica1';
const PORT = parseInt(process.env.PORT || '4001');
const PEERS = (process.env.PEERS || '').split(',').filter(Boolean);
const GATEWAY = process.env.GATEWAY_URL || 'http://gateway:3000';

// Timing (ms)
const HEARTBEAT_MS = 300;
const ELECT_MIN = 1500;
const ELECT_MAX = 3000;
const RPC_TIMEOUT = 1500;

// ── RAFT State ──────────────────────────────────────────────────────
let role = 'follower';
let term = 0;
let votedFor = null;
let leaderId = null;
let raftLog = [];         // [{term, data}]
let commitIndex = -1;
let lastApplied = -1;

// Leader-only volatile state
let nextIdx = {};
let matchIdx = {};

// Timers & guards
let electTimer = null;
let hbTimer = null;
let replicating = false;
let pushing = false;
let syncing = false;
let electionBackoff = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Stagger timeout by replica ID to reduce split-vote probability
const idNum = parseInt(ID.replace(/\D/g, '') || '0');
const bucketOffset = (idNum % 3) * 100;  // 0, 100, or 200ms offset
const randTimeout = () => ELECT_MIN + bucketOffset + Math.random() * (ELECT_MAX - ELECT_MIN);

// ── Timer helpers ───────────────────────────────────────────────────
function resetElectTimer(extraDelay = 0) {
  if (electTimer) clearTimeout(electTimer);
  if (role !== 'leader') {
    electTimer = setTimeout(() => startElection(), randTimeout() + extraDelay);
  }
}

// ── Role transitions ────────────────────────────────────────────────
function stepDown(newTerm, leader = null) {
  role = 'follower';
  term = newTerm;
  votedFor = null;
  leaderId = leader;
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  resetElectTimer();
  console.log(`→ FOLLOWER term=${term} leader=${leaderId}`);
}

async function promoteToLeader() {
  role = 'leader';
  leaderId = ID;
  if (electTimer) { clearTimeout(electTimer); electTimer = null; }

  for (const p of PEERS) {
    nextIdx[p] = raftLog.length;
    matchIdx[p] = -1;
  }

  console.log(`★ LEADER term=${term}`);

  // Start heartbeat interval immediately, then send first heartbeat synchronously
  if (hbTimer) clearInterval(hbTimer);
  hbTimer = setInterval(() => replicateAll(), HEARTBEAT_MS);
  await replicateAll();
  notifyGateway();
}

// ── Gateway notification ────────────────────────────────────────────
async function notifyGateway() {
  const body = { leader_id: ID, leader_url: `http://${ID}:${PORT}`, term };
  for (let i = 0; i < 5; i++) {
    try {
      await axios.post(`${GATEWAY}/notify-leader`, body, { timeout: 2000 });
      console.log('Notified gateway of leadership');
      return;
    } catch { await sleep(500); }
  }
}

// ── Election ────────────────────────────────────────────────────────
async function startElection() {
  if (role === 'leader') return;

  role = 'candidate';
  term++;
  votedFor = ID;
  const elTerm = term;
  const lastIdx = raftLog.length - 1;
  const lastTerm = raftLog.length > 0 ? raftLog[raftLog.length - 1].term : -1;
  resetElectTimer();

  console.log(`⚡ ELECTION term=${elTerm}`);
  let votes = 1;
  let promoted = false;
  const majority = Math.floor((PEERS.length + 1) / 2) + 1;

  // Promote as soon as majority is reached (don't wait for all peers)
  await Promise.allSettled(PEERS.map(async peer => {
    if (promoted || role !== 'candidate' || term !== elTerm) return;
    try {
      const r = await axios.post(`${peer}/request-vote`, {
        term: elTerm, candidate_id: ID,
        last_log_index: lastIdx, last_log_term: lastTerm,
      }, { timeout: RPC_TIMEOUT });

      if (r.data.term > elTerm) { stepDown(r.data.term); return; }
      if (r.data.vote_granted && role === 'candidate' && term === elTerm) {
        votes++;
        console.log(`Vote granted by ${peer} term=${elTerm} (${votes}/${majority})`);
        if (votes >= majority && !promoted) {
          promoted = true;
          electionBackoff = 0;
          await promoteToLeader();
        }
      }
    } catch {}
  }));

  if (!promoted && role === 'candidate' && term === elTerm) {
    electionBackoff = Math.min(electionBackoff + 1, 5);
    const extra = Math.random() * electionBackoff * 300;
    console.log(`Election lost (${votes}/${PEERS.length + 1}) backoff=${Math.round(extra)}ms`);
    role = 'follower';
    resetElectTimer(extra);
  }
}

// ── Replication (leader) ────────────────────────────────────────────
async function replicateAll() {
  if (role !== 'leader' || replicating) return;
  replicating = true;
  try {
    await Promise.allSettled(PEERS.map(p => replicateTo(p)));
    advanceCommit();
  } finally { replicating = false; }
}

async function replicateTo(peer) {
  if (role !== 'leader') return;

  const ni = nextIdx[peer] !== undefined ? nextIdx[peer] : raftLog.length;
  const prevIdx = ni - 1;
  const prevTerm = (prevIdx >= 0 && prevIdx < raftLog.length) ? raftLog[prevIdx].term : -1;
  const entries = raftLog.slice(ni, ni + 64);
  const curTerm = term;

  try {
    const r = await axios.post(`${peer}/append-entries`, {
      term: curTerm, leader_id: ID,
      prev_log_index: prevIdx, prev_log_term: prevTerm,
      entries, leader_commit: commitIndex,
    }, { timeout: RPC_TIMEOUT });

    if (r.data.success) {
      if (entries.length > 0) {
        matchIdx[peer] = ni + entries.length - 1;
        nextIdx[peer] = ni + entries.length;
      }
    } else {
      if (r.data.term > curTerm) { stepDown(r.data.term); return; }
      const ci = r.data.conflict_index !== undefined ? r.data.conflict_index : Math.max(0, ni - 1);
      nextIdx[peer] = Math.max(0, ci);
    }
  } catch {}
}

function advanceCommit() {
  if (role !== 'leader' || raftLog.length === 0) return;
  const majority = Math.floor((PEERS.length + 1) / 2) + 1;

  for (let n = raftLog.length - 1; n > commitIndex; n--) {
    if (raftLog[n].term !== term) continue;
    let count = 1;
    for (const p of PEERS) { if ((matchIdx[p] ?? -1) >= n) count++; }
    if (count >= majority) {
      commitIndex = n;
      console.log(`Committed index=${commitIndex}`);
      pushCommits();
      break;
    }
  }
}

// ── Commit push to gateway ──────────────────────────────────────────
async function pushCommits() {
  if (pushing || lastApplied >= commitIndex) return;
  pushing = true;
  try {
    while (lastApplied < commitIndex) {
      const start = lastApplied + 1;
      const end = commitIndex;
      const entries = [];
      for (let i = start; i <= end && i < raftLog.length; i++) {
        entries.push({ index: i, term: raftLog[i].term, data: raftLog[i].data });
      }
      if (!entries.length) break;

      try {
        await axios.post(`${GATEWAY}/commit-batch`, { entries }, { timeout: 2000 });
        lastApplied = end;
        console.log(`Pushed ${entries.length} commits (up to index=${end})`);
      } catch { break; }
    }
  } finally { pushing = false; }
}

// ── Follower catch-up via /sync-log ─────────────────────────────────
async function syncFromLeader(leaderNodeId, fromIdx) {
  if (syncing) return;
  let url = null;
  for (const p of PEERS) { if (p.includes(leaderNodeId)) { url = p; break; } }
  if (!url) return;

  syncing = true;
  try {
    const r = await axios.post(`${url}/sync-log`, { from_index: fromIdx }, { timeout: 2000 });
    const { entries: missing = [], commit_index: lc = -1, term: lt = term } = r.data;

    if (lt > term) stepDown(lt, leaderNodeId);

    const safe = Math.max(0, fromIdx);
    if (safe < raftLog.length) raftLog.splice(safe);
    raftLog.push(...missing);

    commitIndex = Math.min(lc, raftLog.length - 1);
    resetElectTimer();
    pushCommits();

    if (missing.length) console.log(`Sync catch-up: ${missing.length} entries from ${leaderNodeId}`);
  } catch {} finally { syncing = false; }
}

// ── HTTP Endpoints ──────────────────────────────────────────────────

app.get('/status', (req, res) => {
  res.json({
    id: ID, role, term, leader_id: leaderId,
    log_length: raftLog.length, commit_index: commitIndex,
    last_applied: lastApplied, peers: PEERS,
  });
});

app.get('/log', (req, res) => {
  const committed = raftLog.slice(0, commitIndex + 1).map(e => e.data);
  let lastClear = -1;
  committed.forEach((d, i) => { if (d && d.type === 'clear') lastClear = i; });
  const visible = committed.slice(lastClear + 1).filter(d => !(d && d.type === 'clear'));
  res.json({ log: visible });
});

// Accept single stroke from gateway (leader only)
app.post('/stroke', (req, res) => {
  if (role !== 'leader') {
    return res.status(307).json({ error: 'not_leader', leader_id: leaderId });
  }
  raftLog.push({ term, data: req.body });
  console.log(`Appended stroke index=${raftLog.length - 1}`);
  replicateAll();
  res.json({ ok: true, index: raftLog.length - 1 });
});

// Accept batch of strokes from gateway (leader only)
app.post('/strokes', (req, res) => {
  if (role !== 'leader') {
    return res.status(307).json({ error: 'not_leader', leader_id: leaderId });
  }
  const strokes = req.body.strokes || [];
  if (!strokes.length) return res.json({ ok: true, count: 0 });

  const from = raftLog.length;
  strokes.forEach(s => raftLog.push({ term, data: s }));
  console.log(`Appended batch size=${strokes.length} range=${from}..${raftLog.length - 1}`);
  replicateAll();
  res.json({ ok: true, from_index: from, to_index: raftLog.length - 1, count: strokes.length });
});

// Append replicated clear marker (leader only)
app.post('/clear', (req, res) => {
  if (role !== 'leader') {
    return res.status(307).json({ error: 'not_leader' });
  }
  raftLog.push({ term, data: { type: 'clear' } });
  console.log(`Appended clear index=${raftLog.length - 1}`);
  replicateAll();
  res.json({ ok: true, index: raftLog.length - 1 });
});

// AppendEntries RPC
app.post('/append-entries', (req, res) => {
  const { term: rTerm, leader_id: lid, prev_log_index: pli,
          prev_log_term: plt, entries = [], leader_commit: lc } = req.body;

  if (rTerm < term) return res.json({ term, success: false });

  if (rTerm > term) { stepDown(rTerm, lid); }
  else {
    resetElectTimer();
    leaderId = lid;
    if (role === 'candidate') { role = 'follower'; console.log(`→ FOLLOWER (leader seen) term=${term}`); }
  }

  // Log consistency check
  if (pli >= 0) {
    if (pli >= raftLog.length) {
      syncFromLeader(lid, raftLog.length);
      return res.json({ term, success: false, conflict_index: raftLog.length });
    }
    if (raftLog[pli].term !== plt) {
      const ct = raftLog[pli].term;
      let ci = pli;
      while (ci > 0 && raftLog[ci - 1].term === ct) ci--;
      return res.json({ term, success: false, conflict_index: ci });
    }
  }

  // Append new entries
  let at = pli + 1;
  for (let i = 0; i < entries.length; i++) {
    const idx = at + i;
    if (idx < raftLog.length) {
      if (raftLog[idx].term !== entries[i].term) {
        raftLog.splice(idx);
        raftLog.push(entries[i]);
      }
    } else {
      raftLog.push(entries[i]);
    }
  }

  // Advance commit index
  if (lc > commitIndex) {
    commitIndex = Math.min(lc, raftLog.length - 1);
    pushCommits();
  }

  res.json({ term, success: true });
});

// Heartbeat RPC (lightweight - no entries)
app.post('/heartbeat', (req, res) => {
  const { term: rTerm, leader_id: lid, leader_commit: lc = -1 } = req.body;

  if (rTerm < term) return res.json({ term, success: false });

  if (rTerm > term) { stepDown(rTerm, lid); }
  else {
    leaderId = lid;
    if (role === 'candidate') role = 'follower';
  }
  resetElectTimer();

  if (lc > commitIndex) {
    commitIndex = Math.min(lc, raftLog.length - 1);
    pushCommits();
  }

  res.json({ term, success: true });
});

// RequestVote RPC
app.post('/request-vote', (req, res) => {
  const { term: rTerm, candidate_id: cid, last_log_index: lli, last_log_term: llt } = req.body;

  if (rTerm < term) return res.json({ term, vote_granted: false });
  if (rTerm > term) stepDown(rTerm);

  const myLastIdx = raftLog.length - 1;
  const myLastTerm = raftLog.length > 0 ? raftLog[raftLog.length - 1].term : -1;

  const logOk = llt > myLastTerm || (llt === myLastTerm && lli >= myLastIdx);
  const canVote = votedFor === null || votedFor === cid;

  if (canVote && logOk) {
    votedFor = cid;
    resetElectTimer();
    console.log(`Voted for ${cid} term=${rTerm}`);
    return res.json({ term, vote_granted: true });
  }

  res.json({ term, vote_granted: false });
});

// Sync-log RPC - returns committed entries from given index (leader only)
app.post('/sync-log', (req, res) => {
  if (role !== 'leader') {
    return res.status(307).json({ error: 'not_leader', leader_id: leaderId });
  }
  const from = Math.max(0, req.body.from_index || 0);
  const end = commitIndex + 1;
  const entries = end > from ? raftLog.slice(from, end) : [];
  res.json({ term, leader_id: ID, from_index: from, commit_index: commitIndex, entries });
});

// ── Start server ────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Replica ${ID} started on port ${PORT} peers=${PEERS}`);
  resetElectTimer();
});
