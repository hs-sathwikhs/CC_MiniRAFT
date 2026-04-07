const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");

const statusEl = document.getElementById("status");
const statusDot = document.getElementById("statusDot");
const colorPicker = document.getElementById("colorPicker");
const brushSize = document.getElementById("brushSize");
const brushSizeValue = document.getElementById("brushSizeValue");
const penBtn = document.getElementById("penBtn");
const eraserBtn = document.getElementById("eraserBtn");
const undoBtn = document.getElementById("undoBtn");
const clearLocalBtn = document.getElementById("clearLocalBtn");
const clearAllBtn = document.getElementById("clearAllBtn");
const exportBtn = document.getElementById("exportBtn");
const strokeCountEl = document.getElementById("strokeCount");
const reconnectCountEl = document.getElementById("reconnectCount");
const clientInfoEl = document.getElementById("clientInfo");
const clientSwatch = document.getElementById("clientSwatch");

const protocol = globalThis.location.protocol === "https:" ? "wss" : "ws";
const defaultGatewayHost = `${globalThis.location.hostname}:8080`;
const gatewayHost = new URLSearchParams(globalThis.location.search).get("gateway") || defaultGatewayHost;
const wsUrl = `${protocol}://${gatewayHost}`;

let ws = null;
let reconnectAttempts = 0;
let reconnectCount = 0;
const MAX_RECONNECT_ATTEMPTS = 15;
let reconnectTimeout = null;
let heartbeatInterval = null;
let lastPongTime = Date.now();
let connectionLatency = 0;

let drawing = false;
let lastX = 0;
let lastY = 0;
let isEraser = false;
let totalStrokeSegments = 0;
let currentPath = []; // Track current stroke path for smoothing

let renderedSegments = [];
const localSegments = [];
const strokeBatch = [];
const seenSegmentKeys = new Set();
const remoteRenderQueue = [];
let remoteRenderFrame = null;
let offlineQueueNoticeShown = false;

const MAX_RENDERED_SEGMENTS = 2000;
const MAX_OFFLINE_BATCH = 1000;

const STORAGE_KEY = "miniraft-canvas";
const MAX_LOCAL_STORAGE_BYTES = 900000;

const clientId = Math.random().toString(36).slice(2, 11);
const initialColor = colorPicker?.value || "#0b7a75";
let activeColor = normalizeHexColor(initialColor);

updateClientMeta();
resizeCanvas();
setMode("pen");
setStatus("Connecting...", "#5f6f79");

connectWebSocket();

window.addEventListener("resize", debounce(resizeCanvas, 120));

// Cleanup on page unload
window.addEventListener("beforeunload", () => {
  stopHeartbeat();
  remoteRenderQueue.length = 0;
  if (remoteRenderFrame) {
    cancelAnimationFrame(remoteRenderFrame);
    remoteRenderFrame = null;
  }
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
});

// Save periodically
setInterval(saveToLocalStorage, 30000); // Every 30 seconds

brushSize.addEventListener("input", () => {
  brushSizeValue.textContent = String(brushSize.value);
});

colorPicker.addEventListener("input", () => {
  activeColor = normalizeHexColor(colorPicker.value);
  updateClientMeta();
  if (!isEraser) {
    setMode("pen");
  }
});

penBtn.addEventListener("click", () => setMode("pen"));
eraserBtn.addEventListener("click", () => setMode("eraser"));
undoBtn.addEventListener("click", undoLastLocalStroke);
clearLocalBtn.addEventListener("click", clearLocalOnly);
clearAllBtn.addEventListener("click", clearForEveryone);
exportBtn.addEventListener("click", exportCanvas);

document.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();

  if ((event.ctrlKey || event.metaKey) && key === "z") {
    event.preventDefault();
    undoLastLocalStroke();
    return;
  }

  if (key === "p") {
    setMode("pen");
    return;
  }

  if (key === "e") {
    setMode("eraser");
  }
});

canvas.addEventListener("pointerdown", onPointerDown);
canvas.addEventListener("pointermove", onPointerMove);
canvas.addEventListener("pointerup", onPointerUp);
canvas.addEventListener("pointercancel", onPointerUp);
canvas.addEventListener("pointerleave", onPointerUp);

function connectWebSocket() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  setStatus("Connecting...", "#5f6f79");
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    reconnectAttempts = 0;
    offlineQueueNoticeShown = false;
    setStatus("Connected", "#1f9d55");
    startHeartbeat();
    flushStrokeBatch();
    requestFullLog();
    
    // Reconnect notice after successful recovery
    if (reconnectCount > 0) {
      showToast("Reconnected successfully", "success");
    }
  };

  ws.onmessage = (event) => {
    try {
      const rawData = JSON.parse(event.data);
      const data = normalizeGatewayMessage(rawData);

      if (!data) {
        return;
      }

      // Handle pong for latency monitoring
      if (data.type === "pong") {
        lastPongTime = Date.now();
        connectionLatency = Date.now() - (data.timestamp || lastPongTime);
        updateConnectionQuality();
        return;
      }

      // Compatibility fallback: older gateway echoes ping under { type: "echo", original: {...} }
      if (data.type === "echo" && data.original?.type === "ping") {
        lastPongTime = Date.now();
        connectionLatency = Date.now() - (data.original.timestamp || lastPongTime);
        updateConnectionQuality();
        return;
      }

      if (data.type === "clear") {
        handleRemoteClear();
        return;
      }

      if (data.type === "stroke" && data.stroke) {
        if (data.stroke.kind === "clear") {
          handleRemoteClear();
          return;
        }

        acceptRemoteSegment(data.stroke);
        syncStrokeStats();
      }

      if (data.type === "stroke-batch" && Array.isArray(data.strokes)) {
        data.strokes.forEach((segment) => {
          acceptRemoteSegment(segment);
        });
        syncStrokeStats();
      }

      if (data.type === "full-log" && Array.isArray(data.strokes)) {
        clearCanvas();
        renderedSegments = [];
        localSegments.length = 0;
        seenSegmentKeys.clear();
        data.strokes.forEach((segment) => {
          if (!segment) {
            return;
          }

          rememberSegment(segment);
          drawSegment(segment);
          renderedSegments.push(segment);
          if (segment.source === clientId) {
            localSegments.push(segment);
          }
        });
        syncStrokeStats();
        saveToLocalStorage();
      }

      // Handle leader change notification
      if (data.type === "leader-change") {
        showToast(`Leader changed to replica ${data.leaderId}`, "warning");
      }
    } catch (error) {
      console.error("Failed to parse incoming message", error);
    }
  };

  ws.onclose = () => {
    stopHeartbeat();
    
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      setStatus("Disconnected (max retries)", "#d94848");
      loadFromLocalStorage();
      showToast("Connection lost. Please refresh the page.", "error");
      return;
    }

    reconnectAttempts += 1;
    reconnectCount += 1;
    syncStrokeStats();
    setStatus(`Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`, "#f59e0b");

    // Exponential backoff with jitter
    const baseDelay = 500;
    const exponentialDelay = baseDelay * Math.pow(2, reconnectAttempts - 1);
    const jitter = Math.random() * 500;
    const delay = Math.min(exponentialDelay + jitter, 10000);
    
    reconnectTimeout = globalThis.setTimeout(connectWebSocket, delay);
  };

  ws.onerror = () => {
    setStatus("Connection error", "#d94848");
  };
}

function startHeartbeat() {
  stopHeartbeat();
  lastPongTime = Date.now();
  
  heartbeatInterval = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ 
        type: "ping", 
        timestamp: Date.now() 
      }));
      
      if (Date.now() - lastPongTime > 10000) {
        setStatus("Connection unstable", "#f59e0b");
      }
    }
  }, 2000);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

function updateConnectionQuality() {
  // Update status with latency if connected
  if (ws?.readyState === WebSocket.OPEN && reconnectAttempts === 0) {
    const latencyText = connectionLatency > 0 ? ` (${connectionLatency}ms)` : "";
    setStatus(`Connected${latencyText}`, "#1f9d55");
  }
}

function requestFullLog() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "request-log" }));
  }
}

function onPointerDown(event) {
  drawing = true;
  const point = toCanvasPoint(event);
  lastX = point.x;
  lastY = point.y;
  currentPath = [{ x: point.x, y: point.y }];
  canvas.setPointerCapture(event.pointerId);
}

function onPointerMove(event) {
  if (!drawing) {
    return;
  }

  const point = toCanvasPoint(event);
  currentPath.push({ x: point.x, y: point.y });
  
  // Use quadratic curve for smoother drawing
  if (currentPath.length >= 3) {
    const p0 = currentPath[currentPath.length - 3];
    const p1 = currentPath[currentPath.length - 2];
    const p2 = currentPath[currentPath.length - 1];
    
    // Calculate control point
    const cx = p1.x;
    const cy = p1.y;
    
    const segment = {
      x0: p0.x,
      y0: p0.y,
      x1: p2.x,
      y1: p2.y,
      cx: cx,
      cy: cy,
      color: isEraser ? "#ffffff" : activeColor,
      width: Number(brushSize.value),
      kind: isEraser ? "eraser" : "stroke",
      source: clientId,
      smooth: true,
    };

    drawSegment(segment);
    rememberSegment(segment);
    renderedSegments.push(segment);
    localSegments.push(segment);
    syncStrokeStats();
    sendStroke(segment);
  } else {
    // First segment, draw straight line
    const segment = {
      x0: lastX,
      y0: lastY,
      x1: point.x,
      y1: point.y,
      color: isEraser ? "#ffffff" : activeColor,
      width: Number(brushSize.value),
      kind: isEraser ? "eraser" : "stroke",
      source: clientId,
    };

    drawSegment(segment);
    rememberSegment(segment);
    renderedSegments.push(segment);
    localSegments.push(segment);
    syncStrokeStats();
    sendStroke(segment);
  }

  lastX = point.x;
  lastY = point.y;
}

function onPointerUp(event) {
  if (!drawing) {
    return;
  }

  drawing = false;
  currentPath = [];
  flushStrokeBatch();
  
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
}

function drawSegment(segment) {
  ctx.lineWidth = Number(segment.width) || 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = segment.color || "#111111";
  
  ctx.beginPath();
  
  if (segment.smooth && segment.cx !== undefined && segment.cy !== undefined) {
    // Draw smooth quadratic curve
    ctx.moveTo(segment.x0, segment.y0);
    ctx.quadraticCurveTo(segment.cx, segment.cy, segment.x1, segment.y1);
  } else {
    // Draw straight line
    ctx.moveTo(segment.x0, segment.y0);
    ctx.lineTo(segment.x1, segment.y1);
  }
  
  ctx.stroke();
}

function sendStroke(segment) {
  if (ws?.readyState !== WebSocket.OPEN) {
    // Queue for later if offline and keep memory bounded.
    if (strokeBatch.length >= MAX_OFFLINE_BATCH) {
      strokeBatch.shift();
    }
    strokeBatch.push(segment);

    if (!offlineQueueNoticeShown) {
      showToast("Offline - strokes are being queued", "warning");
      offlineQueueNoticeShown = true;
    }
    return;
  }

  // Send immediately as single stroke for compatibility with all gateway versions.
  ws.send(JSON.stringify({
    type: "stroke",
    clientId,
    stroke: segment,
  }));

  saveToLocalStorage();
}

function flushStrokeBatch() {
  if (strokeBatch.length === 0 || ws?.readyState !== WebSocket.OPEN) {
    return;
  }
  
  const batch = [...strokeBatch];
  strokeBatch.length = 0;

  // Replay queued offline strokes as single-stroke messages.
  batch.forEach((queuedStroke) => {
    ws.send(JSON.stringify({
      type: "stroke",
      clientId,
      stroke: queuedStroke,
    }));
  });

  offlineQueueNoticeShown = false;
  
  saveToLocalStorage();
}

function clearForEveryone() {
  if (!confirm("Clear canvas for all users? This cannot be undone.")) {
    return;
  }

  if (ws?.readyState !== WebSocket.OPEN) {
    showToast("Cannot clear for everyone while offline", "warning");
    return;
  }

  ws.send(JSON.stringify({
    type: "clear",
    clientId,
  }));

  applyLocalClear();
}

function clearLocalOnly() {
  applyLocalClear();
}

function undoLastLocalStroke() {
  if (localSegments.length === 0) {
    showToast("Nothing to undo", "info");
    return;
  }

  const removed = localSegments.pop();
  const index = renderedSegments.lastIndexOf(removed);
  if (index >= 0) {
    renderedSegments.splice(index, 1);
  }
  seenSegmentKeys.clear();
  renderedSegments.forEach((segment) => rememberSegment(segment));
  redrawWithoutBroadcast(renderedSegments);
  showToast("Stroke undone", "info");
}

function redrawWithoutBroadcast(segments) {
  clearCanvas();
  segments.forEach((segment) => drawSegment(segment));
  syncStrokeStats();
}

function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function exportCanvas() {
  try {
    const link = document.createElement("a");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    link.download = `miniraft-canvas-${timestamp}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    showToast("Canvas exported successfully", "success");
  } catch (error) {
    console.error("Failed to export canvas", error);
    showToast("Export failed", "error");
  }
}

function setMode(mode) {
  isEraser = mode === "eraser";

  penBtn.classList.toggle("secondary", isEraser);
  eraserBtn.classList.toggle("secondary", !isEraser);
  canvas.style.cursor = isEraser ? "cell" : "crosshair";
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  const width = Math.max(300, Math.floor(rect.width));
  const height = Math.max(260, Math.floor(rect.height));

  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  clearCanvas();

  renderedSegments.forEach((segment) => drawSegment(segment));
}

function setStatus(text, color) {
  statusEl.textContent = text;
  statusEl.style.color = color;
  statusDot.style.background = color;
}

function updateStats() {
  strokeCountEl.textContent = String(totalStrokeSegments);
  reconnectCountEl.textContent = String(reconnectCount);
}

function syncStrokeStats() {
  totalStrokeSegments = renderedSegments.length;
  updateStats();
}

function handleRemoteClear() {
  applyLocalClear();
  showToast("Canvas cleared by another user", "info");
}

function applyLocalClear() {
  remoteRenderQueue.length = 0;
  if (remoteRenderFrame) {
    cancelAnimationFrame(remoteRenderFrame);
    remoteRenderFrame = null;
  }

  clearCanvas();
  renderedSegments = [];
  localSegments.length = 0;
  seenSegmentKeys.clear();
  syncStrokeStats();
  localStorage.removeItem(STORAGE_KEY);
}

function segmentKey(segment) {
  if (!segment) {
    return "";
  }

  return [
    segment.source || "remote",
    segment.kind || "stroke",
    segment.x0,
    segment.y0,
    segment.x1,
    segment.y1,
    segment.cx,
    segment.cy,
    segment.color,
    segment.width,
    segment.smooth ? 1 : 0,
  ].join("|");
}

function rememberSegment(segment) {
  const key = segmentKey(segment);
  if (key) {
    seenSegmentKeys.add(key);
  }

  pruneInMemorySegments();
}

function shouldSkipRemoteSegment(segment) {
  if (!segment) {
    return true;
  }

  if (segment.source === clientId) {
    return true;
  }

  return seenSegmentKeys.has(segmentKey(segment));
}

function enqueueRemoteSegment(segment) {
  remoteRenderQueue.push(segment);
  if (remoteRenderFrame) {
    return;
  }

  remoteRenderFrame = requestAnimationFrame(() => {
    try {
      while (remoteRenderQueue.length > 0) {
        const pending = remoteRenderQueue.shift();
        drawSegment(pending);
      }
    } finally {
      remoteRenderFrame = null;
    }
  });
}

function acceptRemoteSegment(segment) {
  if (shouldSkipRemoteSegment(segment)) {
    return false;
  }

  rememberSegment(segment);
  renderedSegments.push(segment);
  enqueueRemoteSegment(segment);
  return true;
}

function normalizeGatewayMessage(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  if (data.type !== "echo") {
    return data;
  }

  const original = data.original;
  if (!original || typeof original !== "object") {
    return null;
  }

  if (original.type === "ping") {
    return {
      type: "pong",
      timestamp: original.timestamp,
    };
  }

  if (original.type === "stroke") {
    return {
      type: "stroke",
      stroke: original.stroke,
    };
  }

  if (original.type === "stroke-batch") {
    return {
      type: "stroke-batch",
      strokes: original.strokes,
    };
  }

  if (original.type === "clear") {
    return { type: "clear" };
  }

  return null;
}

function pruneInMemorySegments() {
  if (renderedSegments.length <= MAX_RENDERED_SEGMENTS) {
    return;
  }

  const keepFrom = renderedSegments.length - MAX_RENDERED_SEGMENTS;
  renderedSegments = renderedSegments.slice(keepFrom);

  const localFiltered = localSegments.filter((segment) => renderedSegments.includes(segment));
  localSegments.length = 0;
  localSegments.push(...localFiltered);

  seenSegmentKeys.clear();
  renderedSegments.forEach((segment) => {
    const key = segmentKey(segment);
    if (key) {
      seenSegmentKeys.add(key);
    }
  });
}

function updateClientMeta() {
  clientInfoEl.textContent = `Client ${clientId.slice(0, 6)} | ${activeColor}`;
  clientSwatch.style.background = activeColor;
  colorPicker.value = activeColor;
}

function toCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function normalizeHexColor(color) {
  if (color.startsWith("#") && (color.length === 7 || color.length === 4)) {
    return color;
  }

  return "#0b7a75";
}

function debounce(fn, waitMs) {
  let timeoutId = null;

  return (...args) => {
    globalThis.clearTimeout(timeoutId);
    timeoutId = globalThis.setTimeout(() => fn(...args), waitMs);
  };
}

// Toast notification system
function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: ${type === "success" ? "#1f9d55" : type === "error" ? "#d94848" : type === "warning" ? "#f59e0b" : "#0b7a75"};
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 10000;
    animation: slideIn 0.3s ease-out;
    max-width: 300px;
  `;
  
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = "slideOut 0.3s ease-in";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Local storage backup
function saveToLocalStorage() {
  try {
    // Keep recent segments and trim further if payload gets too large.
    let segments = renderedSegments.slice(-1000);
    let payload = {
      segments,
      timestamp: Date.now(),
      clientId,
    };
    let serialized = JSON.stringify(payload);

    while (serialized.length > MAX_LOCAL_STORAGE_BYTES && segments.length > 100) {
      segments = segments.slice(100);
      payload = {
        segments,
        timestamp: Date.now(),
        clientId,
      };
      serialized = JSON.stringify(payload);
    }

    if (serialized.length <= MAX_LOCAL_STORAGE_BYTES) {
      localStorage.setItem(STORAGE_KEY, serialized);
    }
  } catch {
    // Ignore storage quota and privacy mode errors.
  }
}

function loadFromLocalStorage() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return false;
    
    const data = JSON.parse(saved);
    const age = Date.now() - (data.timestamp || 0);
    
    // Only restore if less than 1 hour old
    if (age > 3600000) {
      localStorage.removeItem(STORAGE_KEY);
      return false;
    }
    
    if (Array.isArray(data.segments) && data.segments.length > 0) {
      renderedSegments = data.segments;
      renderedSegments.forEach((segment) => {
        rememberSegment(segment);
        drawSegment(segment);
      });
      syncStrokeStats();
      showToast("Offline fallback: restored local backup", "info");
      return true;
    }
  } catch {
    // Ignore malformed payloads and storage access failures.
  }
  return false;
}

// Add CSS animations for toasts
const style = document.createElement("style");
style.textContent = `
  @keyframes slideIn {
    from {
      transform: translateX(400px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
  
  @keyframes slideOut {
    from {
      transform: translateX(0);
      opacity: 1;
    }
    to {
      transform: translateX(400px);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);