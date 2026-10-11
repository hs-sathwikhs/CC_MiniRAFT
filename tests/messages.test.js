const test = require('node:test');
const assert = require('node:assert/strict');
const { startCluster, request, eventually, stroke } = require('./cluster');

test('invalid messages do not crash the gateway or enter the log', async t => {
  const cluster = await startCluster(t);
  await cluster.leader();
  const client = await cluster.connect();
  for (const msg of [null, { type: 'strokes', strokes: 'bad' }, { type: 'stroke', stroke: stroke('bad', { x0: -1 }) }]) client.send(msg);
  client.ws.send('{');
  await eventually(() => client.messages.filter(msg => msg.type === 'error').length === 4, 'validation errors');
  assert.equal((await request(cluster.gatewayUrl + '/status')).status, 200);
  const leader = await cluster.leader();
  for (const [route, body] of [
    ['/strokes', { strokes: {} }], ['/stroke', stroke('bad', { width: 1000 })],
    ['/request-vote', { term: 'bad' }], ['/append-entries', {}], ['/heartbeat', {}], ['/sync-log', { from_index: -1 }],
  ]) assert.equal((await request(leader.url + route, body)).status, 400, route);
  assert.equal((await request(cluster.gatewayUrl + '/notify-leader', { leader_id: '<img>', leader_url: 'http://127.0.0.1:9', term: 100 })).status, 400);
  assert.equal((await request(cluster.gatewayUrl + '/commit-batch', { entries: 'bad' })).status, 400);
  client.send({ type: 'stroke', stroke: stroke('valid') });
  await eventually(async () => (await request(leader.url + '/log')).data.log.some(s => s.strokeId === 'valid'), 'valid drawing after errors');
});
