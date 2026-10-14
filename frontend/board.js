const el = id => document.getElementById(id);
const canvas = el('canvas');
const ctx = canvas.getContext('2d');
const preview = el('preview');
const previewCtx = preview.getContext('2d');
const myClientId = sessionStorage.getItem('clientId') || crypto.randomUUID();
sessionStorage.setItem('clientId', myClientId);
el('client-id').textContent = myClientId.slice(0, 8);
const pendingOps = new Map();
let log = [];
let state = boardState(log, myClientId);
let ws;
let ready = false;
let tool = 'draw';
let color = '#1a1a1a';
let brushSize = 3;
let gesture = null;
let reconnects = -1;
let renderFrame = null;
let notice = '';

function setTool(next) {
  tool = next;
  for (const [id, value] of [['btn-pen', 'draw'], ['btn-eraser', 'erase']]) {
    el(id).classList.toggle('active', tool === value);
    el(id).setAttribute('aria-pressed', tool === value);
  }
  preview.style.cursor = tool === 'erase' ? 'cell' : 'crosshair';
}

function drawStroke(target, op, pending = false) {
  target.save();
  target.globalCompositeOperation = op.tool === 'erase' && !pending ? 'destination-out' : 'source-over';
  target.strokeStyle = pending && op.tool === 'erase' ? '#d59d50' : op.color;
  if (pending) { target.globalAlpha = 0.55; target.setLineDash([3, 4]); }
  target.lineWidth = op.width;
  target.lineCap = 'round';
  target.lineJoin = 'round';
  target.beginPath();
  target.moveTo(op.x0, op.y0);
  target.lineTo(op.x1, op.y1);
  target.stroke();
  if (op.x0 === op.x1 && op.y0 === op.y1) {
    target.fillStyle = target.strokeStyle;
    target.beginPath(); target.arc(op.x0, op.y0, op.width / 2, 0, Math.PI * 2); target.fill();
  }
  target.restore();
}

function render() {
  renderFrame = null;
  state = boardState(log, myClientId);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  state.strokes.forEach(op => drawStroke(ctx, op));
  previewCtx.clearRect(0, 0, preview.width, preview.height);
  for (const item of pendingOps.values()) if (item.op.x0 !== undefined) drawStroke(previewCtx, item.op, true);
  el('undoBtn').disabled = pendingOps.size > 0 || !state.undoId;
  el('redoBtn').disabled = pendingOps.size > 0 || !state.redoId;
  el('retryBtn').hidden = ![...pendingOps.values()].some(item => item.failed);
  el('st-strokes').textContent = state.strokes.length;
  el('st-pending').textContent = pendingOps.size;
  el('feedback').textContent = notice || (pendingOps.size ? `${pendingOps.size} pending. Dotted marks are waiting for a commit.` : 'All changes committed.');
}

function scheduleRender() {
  if (!renderFrame) renderFrame = requestAnimationFrame(render);
}

function queueOp(op) {
  if (pendingOps.size >= 1024) { notice = 'Pending buffer is full. Wait for the cluster, then retry.'; scheduleRender(); return false; }
  pendingOps.set(op.strokeId, { op, at: Date.now(), sentAt: 0, failed: false });
  notice = '';
  scheduleRender();
  return true;
}

function flushPending() {
  if (!ready || ws.readyState !== WebSocket.OPEN) return;
  const items = [...pendingOps.values()].filter(item => !item.failed && Date.now() - item.sentAt > 2000);
  for (let idx = 0; idx < items.length; idx += 64) {
    const batch = items.slice(idx, idx + 64);
    ws.send(JSON.stringify({ type: 'ops', strokes: batch.map(item => item.op) }));
    batch.forEach(item => { item.sentAt = Date.now(); });
  }
}

function point(e) {
  const rect = preview.getBoundingClientRect();
  return { x: Math.max(0, Math.min(1100, (e.clientX - rect.left) * 1100 / rect.width)),
    y: Math.max(0, Math.min(680, (e.clientY - rect.top) * 680 / rect.height)) };
}

function segment(next) {
  const op = { x0: gesture.point.x, y0: gesture.point.y, x1: next.x, y1: next.y,
    color: gesture.color, width: gesture.width, tool: gesture.tool, clientId: myClientId,
    drawId: gesture.id, strokeId: crypto.randomUUID() };
  queueOp(op);
  gesture.point = next;
}

preview.addEventListener('pointerdown', e => {
  if (gesture || (e.pointerType === 'mouse' && e.button !== 0)) return;
  e.preventDefault();
  preview.setPointerCapture(e.pointerId);
  gesture = { id: crypto.randomUUID(), pointerId: e.pointerId, point: point(e), color, width: brushSize, tool };
  segment(gesture.point);
});
preview.addEventListener('pointermove', e => {
  if (!gesture || e.pointerId !== gesture.pointerId) return;
  e.preventDefault(); segment(point(e));
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  preview.addEventListener(event, e => { if (gesture?.pointerId === e.pointerId) { gesture = null; flushPending(); } });
}

function undo() {
  if (state.undoId && !pendingOps.size) queueOp({ type: 'undo', drawId: state.undoId, clientId: myClientId, strokeId: crypto.randomUUID() });
}
function redo() {
  if (state.redoId && !pendingOps.size) queueOp({ type: 'redo', drawId: state.redoId, clientId: myClientId, strokeId: crypto.randomUUID() });
}
function clearForEveryone() { el('clearDialog').showModal(); }
el('confirmClear').onclick = () => {
  queueOp({ type: 'clear', clientId: myClientId, strokeId: crypto.randomUUID() });
  el('clearDialog').close();
};
el('cancelClear').onclick = () => el('clearDialog').close();
el('retryBtn').onclick = () => {
  for (const item of pendingOps.values()) { item.failed = false; item.sentAt = 0; item.at = Date.now(); }
  notice = ''; flushPending(); scheduleRender();
};
function exportPNG() {
  const out = document.createElement('canvas');
  out.width = 1100; out.height = 680;
  const target = out.getContext('2d');
  target.fillStyle = '#f4f1e9'; target.fillRect(0, 0, out.width, out.height);
  target.drawImage(canvas, 0, 0);
  const link = document.createElement('a');
  link.download = 'miniraft-board.png'; link.href = out.toDataURL(); link.click();
}
el('color-picker').oninput = e => { color = e.target.value; el('color-hex').textContent = color; };
el('size-slider').oninput = e => { brushSize = Number(e.target.value); el('size-val').textContent = brushSize; };
document.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA', 'BUTTON'].includes(e.target.tagName) || el('clearDialog').open) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (!e.ctrlKey && !e.metaKey) {
    if (e.key.toLowerCase() === 'p') setTool('draw');
    if (e.key.toLowerCase() === 'e') setTool('erase');
  }
});
window.addEventListener('beforeunload', e => { if (pendingOps.size) { e.preventDefault(); e.returnValue = ''; } });

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'full_log') {
      log = msg.log; ready = true;
      reconnects++;
      el('st-reconnects').textContent = reconnects;
      el('conn-pill').className = 'conn-pill online';
      el('conn-text').textContent = 'Connected';
      for (const item of pendingOps.values()) item.sentAt = 0;
      flushPending();
    } else if (msg.type === 'stroke') {
      log.push(msg.stroke);
    } else if (msg.type === 'clear') {
      log = [];
    } else if (msg.type === 'ack' && msg.clientId === myClientId) {
      const item = pendingOps.get(msg.strokeId);
      if (item) el('st-latency').textContent = `${Date.now() - item.at} ms`;
      pendingOps.delete(msg.strokeId);
      if (!pendingOps.size) notice = '';
    } else if (msg.type === 'unconfirmed' || msg.type === 'error') {
      notice = msg.error;
      for (const [id, item] of pendingOps) if (!msg.strokeId || id === msg.strokeId) item.failed = true;
    } else if (msg.type === 'leader_change' || msg.type === 'leader') {
      el('st-leader').textContent = msg.leader_id || 'Electing';
      el('st-term').textContent = msg.term ?? '-';
    }
    scheduleRender();
  };
  ws.onclose = () => {
    ready = false;
    el('conn-pill').className = 'conn-pill offline';
    el('conn-text').textContent = 'Reconnecting';
    setTimeout(connect, 1000);
  };
  ws.onerror = () => {};
}
setInterval(() => {
  for (const item of pendingOps.values()) {
    if (!item.failed && Date.now() - item.at > 17000) {
      item.failed = true; notice = 'No commit confirmed. Retry when the cluster is ready.'; scheduleRender();
    }
  }
  flushPending();
}, 50);
connect();
render();
