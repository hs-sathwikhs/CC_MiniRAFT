const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");

// ============================================================================
// GATEWAY SERVER - Mini-RAFT Collaborative Drawing Board
// Author: Sathwik HS
// 
// Purpose: Accept WebSocket connections from browsers, route drawing strokes
//          to the current RAFT leader, and broadcast committed strokes to all
//          connected clients.
// ============================================================================

const app = express();
app.use(express.json({ limit: "2mb" }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ── Configuration ──────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 8080);

// Replica URLs (can be comma-separated env var or default to localhost)
const REPLICA_URLS = (process.env.REPLICA_URLS || 
    "http://localhost:5001,http://localhost:5002,http://localhost:5003")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

// ── State ──────────────────────────────────────────────────────────────────
let knownLeaderUrl = null;           // Cached leader URL
let knownLeaderId = null;            // Cached leader replica ID
let connectedClients = new Set();    // Set of connected WebSocket clients
let messageCount = 0;                // Total messages received
let broadcastCount = 0;              // Total broadcasts sent

// ── Logging Helper ─────────────────────────────────────────────────────────
function logInfo(message, data = {}) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [GATEWAY] ${message}`, 
        Object.keys(data).length > 0 ? JSON.stringify(data) : "");
}

function logError(message, error) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [GATEWAY] ERROR: ${message}`, error.message || error);
}

// ── WebSocket Connection Handling ──────────────────────────────────────────

wss.on("connection", (ws, req) => {
    const clientId = `client-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    connectedClients.add(ws);
    
    logInfo("New client connected", { 
        clientId, 
        totalClients: connectedClients.size,
        ip: req.socket.remoteAddress 
    });

    // Send welcome message
    ws.send(JSON.stringify({
        type: "welcome",
        message: "Connected to Mini-RAFT Gateway",
        clientId: clientId
    }));

    // Handle incoming messages from browser
    ws.on("message", (rawMessage) => {
        try {
            messageCount++;
            const message = JSON.parse(rawMessage.toString());
            
            logInfo("Message received from client", { 
                clientId, 
                type: message.type,
                messageNumber: messageCount 
            });

            // Day 1: Echo back to sender (will be replaced with leader routing on Day 2)
            ws.send(JSON.stringify({
                type: "echo",
                original: message,
                timestamp: Date.now()
            }));

        } catch (error) {
            logError("Failed to parse client message", error);
            ws.send(JSON.stringify({
                type: "error",
                message: "Invalid message format"
            }));
        }
    });

    // Handle client disconnection
    ws.on("close", () => {
        connectedClients.delete(ws);
        logInfo("Client disconnected", { 
            clientId, 
            remainingClients: connectedClients.size 
        });
    });

    // Handle errors
    ws.on("error", (error) => {
        logError(`WebSocket error for ${clientId}`, error);
        connectedClients.delete(ws);
    });
});

// ── HTTP Endpoints ─────────────────────────────────────────────────────────

// Health check endpoint
app.get("/health", (req, res) => {
    res.json({
        status: "healthy",
        service: "miniraft-gateway",
        connectedClients: connectedClients.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Statistics endpoint
app.get("/stats", (req, res) => {
    res.json({
        connectedClients: connectedClients.size,
        totalMessagesReceived: messageCount,
        totalBroadcasts: broadcastCount,
        knownLeader: knownLeaderId,
        uptime: process.uptime()
    });
});

// Serve simple test page for Day 1
app.get("/", (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Mini-RAFT Gateway Test</title>
            <style>
                body {
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    max-width: 800px;
                    margin: 50px auto;
                    padding: 20px;
                    background: #f5f5f5;
                }
                .container {
                    background: white;
                    padding: 30px;
                    border-radius: 8px;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                }
                h1 { color: #333; }
                .status {
                    padding: 10px;
                    margin: 10px 0;
                    border-radius: 4px;
                    font-weight: bold;
                }
                .connected { background: #d4edda; color: #155724; }
                .disconnected { background: #f8d7da; color: #721c24; }
                #messages {
                    height: 300px;
                    overflow-y: auto;
                    border: 1px solid #ddd;
                    padding: 10px;
                    margin: 15px 0;
                    background: #fafafa;
                    font-family: monospace;
                    font-size: 12px;
                }
                input {
                    width: calc(100% - 100px);
                    padding: 10px;
                    font-size: 14px;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                }
                button {
                    padding: 10px 20px;
                    font-size: 14px;
                    background: #007bff;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    margin-left: 10px;
                }
                button:hover { background: #0056b3; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🚀 Mini-RAFT Gateway - Day 1 Test</h1>
                <div id="status" class="status disconnected">Disconnected</div>
                <div id="messages"></div>
                <input type="text" id="messageInput" placeholder="Type a message and press Enter or click Send">
                <button onclick="sendMessage()">Send</button>
            </div>
            
            <script>
                const messagesDiv = document.getElementById('messages');
                const statusDiv = document.getElementById('status');
                const messageInput = document.getElementById('messageInput');
                
                // Connect to WebSocket
                const ws = new WebSocket('ws://' + window.location.host);
                
                ws.onopen = () => {
                    statusDiv.className = 'status connected';
                    statusDiv.textContent = 'Connected to Gateway ✓';
                    addMessage('System', 'Connected to WebSocket server', 'green');
                };
                
                ws.onclose = () => {
                    statusDiv.className = 'status disconnected';
                    statusDiv.textContent = 'Disconnected from Gateway ✗';
                    addMessage('System', 'Disconnected from server', 'red');
                };
                
                ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        addMessage('Server', JSON.stringify(data, null, 2), 'blue');
                    } catch (error) {
                        addMessage('Server', event.data, 'blue');
                    }
                };
                
                ws.onerror = (error) => {
                    addMessage('System', 'WebSocket error occurred', 'red');
                };
                
                function sendMessage() {
                    const text = messageInput.value.trim();
                    if (!text) return;
                    
                    const message = {
                        type: 'test',
                        content: text,
                        timestamp: Date.now()
                    };
                    
                    ws.send(JSON.stringify(message));
                    addMessage('You', text, 'black');
                    messageInput.value = '';
                }
                
                messageInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') sendMessage();
                });
                
                function addMessage(sender, text, color) {
                    const time = new Date().toLocaleTimeString();
                    const msgDiv = document.createElement('div');
                    msgDiv.style.color = color;
                    msgDiv.style.marginBottom = '5px';
                    msgDiv.textContent = \`[\${time}] \${sender}: \${text}\`;
                    messagesDiv.appendChild(msgDiv);
                    messagesDiv.scrollTop = messagesDiv.scrollHeight;
                }
            </script>
        </body>
        </html>
    `);
});

// ── Server Startup ─────────────────────────────────────────────────────────

server.listen(PORT, () => {
    logInfo("🚀 Gateway server started", { 
        port: PORT, 
        replicas: REPLICA_URLS,
        webSocketReady: true
    });
    console.log("");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("  Mini-RAFT Gateway Server - Day 1: WebSocket Foundation");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`  URL: http://localhost:${PORT}`);
    console.log(`  Connected Clients: 0`);
    console.log(`  Replica URLs: ${REPLICA_URLS.join(", ")}`);
    console.log("═══════════════════════════════════════════════════════════");
    console.log("");
});

// Graceful shutdown
process.on("SIGTERM", () => {
    logInfo("Received SIGTERM, shutting down gracefully");
    server.close(() => {
        logInfo("Server closed");
        process.exit(0);
    });
});

process.on("SIGINT", () => {
    logInfo("Received SIGINT, shutting down gracefully");
    server.close(() => {
        logInfo("Server closed");
        process.exit(0);
    });
});
