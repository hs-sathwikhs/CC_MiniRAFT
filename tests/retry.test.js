const test = require('node:test');
const assert = require('node:assert/strict');
const { startCluster, request, eventually, pause, stroke } = require('./cluster');

test('drawing queued during an election commits once and survives reconnect retries', async t => {
  const cluster = await startCluster(t);
  const first = await cluster.leader();
  const client = await cluster.connect();
  await cluster.stop(first.idx);
  const op = stroke('duringElection');
  client.send({ type: 'strokes', strokes: [op, op] });
  client.ws.close();
  const next = await cluster.connect();
  next.send({ type: 'stroke', stroke: op });
  await eventually(() => next.messages.some(msg => msg.type === 'ack' && msg.strokeId === op.strokeId), 'commit acknowledgement');
  const leader = await cluster.leader();
  assert.notEqual(leader.id, first.id);
  assert.deepEqual((await request(leader.url + '/log')).data.log, [op]);
  assert.equal((await request(leader.url + '/stroke', op)).status, 200);
  assert.equal((await request(leader.url + '/stroke', { ...op, color: '#ffffff' })).status, 409);
  await pause(200);
  assert.deepEqual((await request(leader.url + '/log')).data.log, [op]);
});

test('pending clear stays in order and retries cannot restore a cleared stroke', async t => {
  const cluster = await startCluster(t);
  const leader = await cluster.leader();
  const followers = [0, 1, 2].filter(idx => idx !== leader.idx);
  const client = await cluster.connect();
  await Promise.all(followers.map(cluster.stop));
  await pause(900);
  const before = stroke('beforeClear');
  const after = stroke('afterClear');
  client.send({ type: 'stroke', stroke: before });
  client.send({ type: 'clear', clientId: 'testClient', strokeId: 'clearBoard' });
  client.send({ type: 'stroke', stroke: after });
  await pause(700);
  assert.equal(client.messages.filter(msg => msg.type === 'ack').length, 0);
  assert.equal((await request(cluster.gatewayUrl + '/status')).data.pending_strokes, 3);
  cluster.startReplica(followers[0]);
  await eventually(() => client.messages.filter(msg => msg.type === 'ack').length === 3, 'buffer commits after quorum returns');
  assert.deepEqual((await request(leader.url + '/log')).data.log, [after]);
  client.send({ type: 'stroke', stroke: before });
  await eventually(() => client.messages.filter(msg => msg.type === 'ack').length === 4, 'old retry acknowledgement');
  await pause(200);
  assert.deepEqual((await request(leader.url + '/log')).data.log, [after]);
  await cluster.stop('gateway');
  cluster.startGateway();
  const replay = await cluster.connect();
  replay.send({ type: 'stroke', stroke: before });
  await eventually(() => replay.messages.some(msg => msg.type === 'ack' && msg.strokeId === before.strokeId));
  assert.deepEqual((await request(leader.url + '/log')).data.log, [after]);
});

test('the pending buffer is bounded and reports unconfirmed writes without quorum', async t => {
  const cluster = await startCluster(t);
  const leader = await cluster.leader();
  await Promise.all([0, 1, 2].filter(idx => idx !== leader.idx).map(cluster.stop));
  await pause(900);
  const client = await cluster.connect();
  for (let batch = 0; batch < 64; batch++) {
    client.send({ type: 'strokes', strokes: Array.from({ length: 64 }, (val, idx) => stroke(`buffer${batch * 64 + idx}`)) });
  }
  client.send({ type: 'stroke', stroke: stroke('overLimit') });
  await eventually(() => client.messages.some(msg => msg.error === 'drawing queue is full'), 'full queue feedback');
  assert.equal((await request(cluster.gatewayUrl + '/status')).data.pending_strokes, 4096);
  await eventually(() => client.messages.some(msg => msg.type === 'unconfirmed'), 'unconfirmed feedback', 17000);
  assert.equal(client.messages.filter(msg => msg.type === 'ack').length, 0);
  assert.deepEqual((await request(leader.url + '/log')).data.log, []);
});
