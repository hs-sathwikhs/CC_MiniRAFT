const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startCluster, request, eventually, pause, stroke } = require('./cluster');

async function waitForStroke(urls, id) {
  await eventually(async () => (await Promise.all(urls.map(url => request(url + '/log'))))
    .every(res => res.data.log.some(op => op.strokeId === id)), `replication of ${id}`);
}

test('two replicas keep drawing through follower loss, leader replacement and rejoin', async t => {
  const cluster = await startCluster(t);
  const client = await cluster.connect();
  const first = await cluster.leader();
  client.send({ type: 'stroke', stroke: stroke('beforeFailure') });
  await waitForStroke(cluster.urls, 'beforeFailure');
  const follower = (first.idx + 1) % 3;
  await cluster.stop(follower);
  client.send({ type: 'stroke', stroke: stroke('withoutFollower') });
  await waitForStroke(cluster.urls.filter((url, idx) => idx !== follower), 'withoutFollower');
  assert.equal((await cluster.leader()).id, first.id);
  cluster.startReplica(follower);
  await waitForStroke(cluster.urls, 'withoutFollower');
  await cluster.stop(first.idx);
  const next = await cluster.leader();
  assert.notEqual(next.id, first.id);
  assert.ok(next.term > first.term);
  client.send({ type: 'stroke', stroke: stroke('newLeader') });
  await waitForStroke(cluster.urls.filter((url, idx) => idx !== first.idx), 'newLeader');
  cluster.startReplica(first.idx);
  await waitForStroke(cluster.urls, 'newLeader');
  assert.equal(client.ws.readyState, 1);
  const logs = await Promise.all(cluster.urls.map(async url => (await request(url + '/log')).data.log));
  assert.deepEqual(logs[0], logs[1]);
  assert.deepEqual(logs[1], logs[2]);
  const replay = await cluster.connect();
  await eventually(() => replay.messages.some(msg => msg.type === 'full_log' && msg.log.length === 3), 'new client replay');
  await request(cluster.gatewayUrl + '/clear', {});
  await eventually(async () => (await request(next.url + '/log')).data.log.length === 0, 'replicated clear');
});

test('one replica cannot commit and resumes when a majority returns', async t => {
  const cluster = await startCluster(t);
  const leader = await cluster.leader();
  const followers = [0, 1, 2].filter(idx => idx !== leader.idx);
  await Promise.all(followers.map(cluster.stop));
  const before = (await request(leader.url + '/status')).data.commit_index;
  await request(leader.url + '/stroke', stroke('waitingForQuorum'));
  await pause(800);
  const alone = (await request(leader.url + '/status')).data;
  assert.equal(alone.commit_index, before);
  assert.equal(alone.hasQuorum, false);
  assert.equal((await request(leader.url + '/log')).data.log.length, 0);
  cluster.startReplica(followers[0]);
  await waitForStroke([leader.url, cluster.urls[followers[0]]], 'waitingForQuorum');
});

test('gateway recovery reads missed commits and forged hints add no data', async t => {
  const cluster = await startCluster(t);
  const leader = await cluster.leader();
  await cluster.stop('gateway');
  await request(leader.url + '/stroke', stroke('gatewayWasDown'));
  await waitForStroke(cluster.urls, 'gatewayWasDown');
  cluster.startGateway();
  await eventually(async () => (await request(cluster.gatewayUrl + '/status')).status === 200);
  const client = await cluster.connect();
  await eventually(() => client.messages.some(msg => msg.type === 'full_log' && msg.log.some(op => op.strokeId === 'gatewayWasDown')));
  await request(cluster.gatewayUrl + '/commit-batch', { leader_id: leader.id, term: leader.term, entries: [{ index: 999, term: leader.term, data: stroke('forged') }] });
  await pause(300);
  assert.ok(!client.messages.some(msg => JSON.stringify(msg).includes('forged')));
});

test('committed prefixes, heartbeat bounds and one vote per term are protected', async t => {
  const cluster = await startCluster(t);
  const leader = await cluster.leader();
  await request(leader.url + '/stroke', stroke('keepThis'));
  await waitForStroke(cluster.urls, 'keepThis');
  const idx = (leader.idx + 1) % 3;
  const others = [0, 1, 2].filter(other => other !== idx);
  await Promise.all(others.map(cluster.stop));
  const url = cluster.urls[idx];
  const before = (await request(url + '/status')).data;
  const term = before.term + 10;
  const body = { term, leader_id: cluster.ids[others[0]], prev_log_index: -1, prev_log_term: -1, leader_commit: before.commit_index };
  const overwrite = await request(url + '/append-entries', { ...body, entries: [{ term, data: stroke('replacement') }] });
  assert.equal(overwrite.data.success, false);
  await request(url + '/heartbeat', { ...body, entries: [], leader_commit: 999 });
  assert.equal((await request(url + '/status')).data.commit_index, before.commit_index);
  assert.deepEqual((await request(url + '/log')).data.log, [stroke('keepThis')]);
  const vote = { term: term + 1, candidate_id: cluster.ids[others[0]], last_log_index: before.log_length - 1, last_log_term: before.term };
  assert.equal((await request(url + '/request-vote', vote)).data.vote_granted, true);
  assert.equal((await request(url + '/request-vote', { ...vote, candidate_id: cluster.ids[others[1]] })).data.vote_granted, false);
  assert.equal((await request(url + '/request-vote', { ...vote, term: before.term })).data.vote_granted, false);
});

test('a delayed election reply cannot move a node back to an older term', async t => {
  const cluster = await startCluster(t);
  await Promise.all([0, 1, 2].map(cluster.stop));
  const held = [];
  const mocks = await Promise.all([1, 2].map(idx => new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url === '/request-vote') held.push(res);
      else { res.setHeader('content-type', 'application/json'); res.end('{"term":0,"success":false}'); }
    });
    server.listen(Number(new URL(cluster.urls[idx]).port), '0.0.0.0', () => resolve(server));
  })));
  t.after(() => { for (const server of mocks) { server.closeAllConnections(); server.close(); } });
  cluster.startReplica(0);
  await eventually(() => held.length > 0, 'outstanding vote request');
  await request(cluster.urls[0] + '/request-vote', {
    term: 20, candidate_id: cluster.ids[1], last_log_index: -1, last_log_term: -1,
  });
  for (const res of held) { res.setHeader('content-type', 'application/json'); res.end('{"term":10,"vote_granted":false}'); }
  await pause(50);
  assert.equal((await request(cluster.urls[0] + '/status')).data.term, 20);
});
