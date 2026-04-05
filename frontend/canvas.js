const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");

let drawing = false;
let lastX = 0;
let lastY = 0;

// WebSocket Connection
const ws = new WebSocket('ws://localhost:8080');

ws.onopen = () => {
  console.log('Connected to gateway');
  const status = document.getElementById('status');
  if (status) status.textContent = 'Connected to gateway';
};

ws.onclose = () => {
  console.log('Disconnected from gateway');
  const status = document.getElementById('status');
  if (status) status.textContent = 'Disconnected from gateway';
};

ws.onerror = (err) => {
  console.log('WebSocket error', err);
  const status = document.getElementById('status');
  if (status) status.textContent = 'WebSocket error';
};

// Receive strokes from other clients
ws.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data);

    if (data.type === 'stroke') {
      drawRemoteStroke(data.stroke);
    }

    if (data.type === 'full-log') {
      data.strokes.forEach(stroke => drawRemoteStroke(stroke));
    }

  } catch (e) {
    console.error('Failed to parse message:', e);
  }
};

// Draw a stroke received from gateway
function drawRemoteStroke(stroke) {
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#000000';
  ctx.beginPath();
  ctx.moveTo(stroke.x0, stroke.y0);
  ctx.lineTo(stroke.x1, stroke.y1);
  ctx.stroke();
}

// Mouse Events
canvas.addEventListener('mousedown', (e) => {
  drawing = true;
  lastX = e.offsetX;
  lastY = e.offsetY;
});

canvas.addEventListener('mouseup', () => {
  drawing = false;
  ctx.beginPath();
});

canvas.addEventListener('mouseleave', () => {
  drawing = false;
  ctx.beginPath();
});

canvas.addEventListener('mousemove', draw);

// Draw locally + send to gateway
function draw(e) {
  if (!drawing) return;

  const x1 = e.offsetX;
  const y1 = e.offsetY;

  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#000000';
  ctx.beginPath();
  ctx.moveTo(lastX, lastY);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'stroke',
      stroke: {
        x0: lastX,
        y0: lastY,
        x1: x1,
        y1: y1
      }
    }));
  }

  lastX = x1;
  lastY = y1;
}