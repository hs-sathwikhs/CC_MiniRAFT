const test = require('node:test');
const assert = require('node:assert/strict');
const boardState = require('../frontend/boardState');
const { startCluster, request, eventually, stroke } = require('./cluster');

test('shared undo groups a gesture, respects its owner and replays after failover', async t => {
  const cluster = await startCluster(t);
  const client = await cluster.connect();
  const viewer = await cluster.connect();
  const ops = [stroke('a1', { drawId: 'first' }), stroke('b1', { clientId: 'otherClient', drawId: 'first' }),
    stroke('a2', { drawId: 'first' }), stroke('erase1', { drawId: 'eraser', tool: 'erase' })];
  client.send({ type: 'ops', strokes: ops });
  await eventually(() => client.messages.filter(msg => msg.type === 'ack').length === 4);
  client.send({ type: 'ops', strokes: [{ type: 'undo', clientId: 'testClient', drawId: 'eraser', strokeId: 'undoErase' }] });
  await eventually(() => viewer.messages.filter(msg => msg.type === 'stroke').length === 5);
  let replay = viewer.messages.filter(msg => msg.type === 'stroke').map(msg => msg.stroke);
  assert.deepEqual(boardState(replay, 'testClient').strokes, ops.slice(0, 3));
  client.send({ type: 'ops', strokes: [{ type: 'undo', clientId: 'testClient', drawId: 'first', strokeId: 'undoDraw' }] });
  await eventually(() => viewer.messages.filter(msg => msg.type === 'stroke').length === 6);
  replay = viewer.messages.filter(msg => msg.type === 'stroke').map(msg => msg.stroke);
  assert.deepEqual(boardState(replay, 'testClient').strokes, [ops[1]]);
  await cluster.stop((await cluster.leader()).idx);
  client.send({ type: 'ops', strokes: [{ type: 'redo', clientId: 'testClient', drawId: 'first', strokeId: 'redoDraw' }] });
  await eventually(() => viewer.messages.filter(msg => msg.type === 'stroke').length === 7);
  const newcomer = await cluster.connect();
  replay = newcomer.messages.find(msg => msg.type === 'full_log').log;
  assert.deepEqual(boardState(replay, 'testClient').strokes, ops.slice(0, 3));
  assert.equal(boardState(replay, 'testClient').redoId, 'eraser');
  client.send({ type: 'clear', clientId: 'testClient', strokeId: 'clearUndoHistory' });
  await eventually(() => viewer.messages.some(msg => msg.type === 'clear'));
  const leader = await cluster.leader();
  assert.deepEqual(boardState((await request(leader.url + '/log')).data.log, 'testClient'), { strokes: [], undoId: undefined, redoId: undefined });
});
