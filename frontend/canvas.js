const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");

let drawing = false;
let lastX = 0;
let lastY = 0;

// Generate unique client ID + color
const clientId = Math.random().toString(36).substr(2, 9);
const clientColor = '#' + Math.floor(Math.random()*16777215).toString(16);
console.log('Client ID:', clientId, 'Color:', clientColor);

// WebSocket Connection with Auto-Reconnect
let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

function connectWebSocket() {
  ws = new WebSocket('ws://localhost:8080');

  ws.onopen = () => {
    console.log('Connected to gateway');
    reconnectAttempts = 0;
    updateStatus('Connected', '#22c55e');
  };

  ws.onclose = () => {
    console.log('Disconnected. Attempting to reconnect...');
    updateStatus('Reconnecting...', '#f59e0b');
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 5000);
      console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
      setTimeout(connectWebSocket, delay);
    } else {
      updateStatus('Disconnected - max retries', '#ef4444');
    }
  };

  ws.onerror = (err) => {
    console.error('WebSocket error', err);
    updateStatus('Connection error', '#ef4444');
  };
}

function updateStatus(text, color = '#6b7280') {
  const status = document.getElementById('status');
  if (status) {
    status.textContent = text;
    status.style.color = color;
  }
}

connectWebSocket();

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
  ctx.strokeStyle = stroke.color || '#000000';
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

// Touch Events (for multi-device support)
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const touch = e.touches[0];
  drawing = true;
  lastX = touch.clientX - rect.left;
  lastY = touch.clientY - rect.top;
});

canvas.addEventListener('touchend', () => {
  drawing = false;
  ctx.beginPath();
});

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const touch = e.touches[0];
  draw({
    offsetX: touch.clientX - rect.left,
    offsetY: touch.clientY - rect.top
  });
});

// Draw locally + send to gateway
function draw(e) {
  if (!drawing) return;

  const x1 = e.offsetX;
  const y1 = e.offsetY;

  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = clientColor;
  ctx.beginPath();
  ctx.moveTo(lastX, lastY);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'stroke',
      clientId: clientId,
      stroke: {
        x0: lastX,
        y0: lastY,
        x1: x1,
        y1: y1,
        color: clientColor
      }
    }));
  }

  lastX = x1;
  lastY = y1;
}