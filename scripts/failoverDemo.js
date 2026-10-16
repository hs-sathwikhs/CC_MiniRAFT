const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { WebSocket } = require('../gateway/node_modules/ws');

const root = path.resolve(__dirname, '..');
const stopped = new Set();
const baseUrl = process.env.BOARD_URL || 'http://localhost:8080';
const clientId = `demo-${randomUUID()}`;
let ws;

async function waitFor(check, msg, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const val = await check(); if (val) return val; } catch {}
    await new Promise(res => setTimeout(res, 100));
  }
  throw new Error(`timed out: ${msg}`);
}

async function status() {
  const res = await fetch(`${baseUrl}/api/dashboard-data`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`gateway returned ${res.status}`);
  return res.json();
}

function compose(action, node) {
  if (!['replica1', 'replica2', 'replica3'].includes(node)) throw new Error('unexpected replica id');
  if (action === 'stop') stopped.add(node);
  execFileSync('docker', ['compose', action, node], { cwd: root, stdio: 'pipe', timeout: 30000 });
  if (action === 'start') stopped.delete(node);
}

async function draw(label, row) {
  const strokeId = randomUUID();
  const msg = { type: 'stroke', stroke: { x0: 80, y0: row, x1: 320, y1: row,
    color: '#ac7e36', width: 4, tool: 'draw', clientId, strokeId, drawId: strokeId } };
  let committed = false;
  const onMessage = raw => {
    const data = JSON.parse(raw);
    if (data.type === 'ack' && data.strokeId === strokeId) committed = true;
  };
  ws.on('message', onMessage);
  try {
    ws.send(JSON.stringify(msg));
    await waitFor(() => committed, label);
    console.log(`PASS: ${label}`);
  } finally { ws.off('message', onMessage); }
}

async function caughtUp() {
  return waitFor(async () => {
    const data = await status();
    return data.cluster.hasQuorum && data.replicas.length === 3 && data.replicas.every(node => node.online
      && node.commit_index === data.cluster.commitIndex);
  }, 'all replicas caught up');
}

async function run() {
  await caughtUp();
  ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws`);
  ws.on('error', () => {});
  await waitFor(() => ws.readyState === WebSocket.OPEN, 'drawing connection');
  const first = (await status()).cluster.leaderId;
  console.log(`Leader: ${first}`);
  await draw('drawing with all three replicas', 80);
  const follower = ['replica1', 'replica2', 'replica3'].find(id => id !== first);
  compose('stop', follower);
  await draw('drawing with one follower stopped', 110);
  compose('start', follower);
  await caughtUp();
  console.log(`PASS: ${follower} caught up after restart`);
  compose('stop', first);
  await draw('drawing queued during leader replacement', 140);
  const next = await waitFor(async () => {
    const cfg = (await status()).cluster;
    return cfg.hasQuorum && cfg.leaderId !== first && cfg.leaderId;
  }, 'replacement leader');
  console.log(`New leader: ${next}`);
  compose('start', first);
  await caughtUp();
  console.log(`PASS: ${first} rejoined and all three commit indexes match`);
}

function cleanup() {
  ws?.terminate();
  for (const node of stopped) {
    try { compose('start', node); }
    catch { console.error(`Could not restart ${node}. Run: docker compose start ${node}`); process.exitCode = 1; }
  }
}

process.once('SIGINT', () => { cleanup(); process.exit(130); });
run().catch(err => { console.error(err.message); process.exitCode = 1; }).finally(cleanup);
