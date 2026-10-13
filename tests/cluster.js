const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { WebSocket } = require('../gateway/node_modules/ws');

const pause = ms => new Promise(res => setTimeout(res, ms));
async function eventually(check, message = 'condition', timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch {}
    await pause(50);
  }
  throw new Error(`timed out waiting for ${message}`);
}

async function request(url, body) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(1500),
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: res.status, data: await res.json() };
}

async function startCluster(t) {
  const reservations = await Promise.all(Array.from({ length: 4 }, () => new Promise(res => {
    const server = net.createServer();
    server.listen(0, '0.0.0.0', () => res(server));
  })));
  const ports = reservations.map(server => server.address().port);
  await Promise.all(reservations.map(server => new Promise(res => server.close(res))));
  const ids = ['127.0.0.1', '127.0.0.2', '127.0.0.3'];
  const urls = ids.map((id, idx) => `http://${id}:${ports[idx]}`);
  const gatewayUrl = `http://127.0.0.1:${ports[3]}`;
  const root = path.resolve(__dirname, '..');
  const processes = new Map();
  const sockets = new Set();

  function launch(key, file, env) {
    const child = spawn(process.execPath, [path.join(root, file)], {
      env: { ...process.env, NO_PROXY: ids.join(','), ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', chunk => { child.errorLog = (child.errorLog || '') + chunk; });
    processes.set(key, child);
    return child;
  }

  async function stop(key) {
    const child = processes.get(key);
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(res => { child.once('exit', res); child.kill('SIGTERM'); });
  }

  function startReplica(idx) {
    return launch(idx, 'replica/server.js', {
      REPLICA_ID: ids[idx], PORT: String(ports[idx]),
      PEERS: urls.filter((url, other) => idx !== other).join(','), GATEWAY_URL: gatewayUrl,
    });
  }

  function startGateway() {
    return launch('gateway', 'gateway/server.js', { GATEWAY_PORT: String(ports[3]), REPLICA_URLS: urls.join(',') });
  }

  async function connect() {
    await eventually(async () => (await request(gatewayUrl + '/status')).status === 200, 'gateway ready');
    const ws = new WebSocket(gatewayUrl.replace('http:', 'ws:') + '/ws');
    const messages = [];
    sockets.add(ws);
    ws.on('message', raw => messages.push(JSON.parse(raw)));
    ws.on('error', () => {});
    await eventually(() => ws.readyState === WebSocket.OPEN, 'websocket open');
    await eventually(() => messages.some(msg => msg.type === 'full_log'), 'initial replay');
    return { ws, messages, send: msg => ws.send(JSON.stringify(msg)) };
  }

  const statuses = () => Promise.all(urls.map(async url => {
    try { return (await request(url + '/status')).data; } catch { return null; }
  }));
  const leader = () => eventually(async () => {
    const states = await statuses();
    const idx = states.findIndex(state => state?.role === 'leader');
    return idx < 0 ? null : { idx, url: urls[idx], ...states[idx] };
  }, 'leader election');

  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await Promise.all([...processes.keys()].map(stop));
    for (const child of processes.values()) {
      if (child.exitCode && child.errorLog) t.diagnostic(child.errorLog);
    }
  });
  ids.forEach((id, idx) => startReplica(idx));
  startGateway();
  await eventually(async () => (await statuses()).every(Boolean), 'replica startup');
  await eventually(async () => (await request(gatewayUrl + '/status')).status === 200, 'gateway startup');
  return { ids, urls, gatewayUrl, stop, startReplica, startGateway, statuses, leader, connect };
}

function stroke(strokeId, extra = {}) {
  return { x0: 10, y0: 10, x1: 50, y1: 50, color: '#273544', width: 3, tool: 'draw', clientId: 'testClient', strokeId, ...extra };
}

module.exports = { startCluster, request, eventually, pause, stroke };
