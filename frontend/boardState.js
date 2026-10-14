function boardState(log, clientId) {
  const groups = new Map();
  const hidden = new Set();
  const undone = [];
  const strokes = [];
  for (const op of log) {
    const key = `${op.clientId}:${op.drawId || op.strokeId}`;
    if (op.type === 'clear') {
      groups.clear(); hidden.clear(); undone.length = 0; strokes.length = 0;
    } else if (op.type === 'undo') {
      hidden.add(key);
      undone.push(key);
    } else if (op.type === 'redo') {
      hidden.delete(key);
    } else if (op.x0 !== undefined) {
      groups.set(key, op);
      strokes.push(op);
    }
  }
  const mine = [...groups].filter(([key, op]) => op.clientId === clientId && !hidden.has(key));
  const redoKey = undone.findLast(key => hidden.has(key) && groups.get(key)?.clientId === clientId);
  return {
    strokes: strokes.filter(op => !hidden.has(`${op.clientId}:${op.drawId || op.strokeId}`)),
    undoId: mine.at(-1)?.[1].drawId || mine.at(-1)?.[1].strokeId,
    redoId: groups.get(redoKey)?.drawId || groups.get(redoKey)?.strokeId,
  };
}

if (typeof module !== 'undefined') module.exports = boardState;
