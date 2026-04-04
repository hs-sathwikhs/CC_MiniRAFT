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
let strokesForwarded = 0;            // Total strokes forwarded to leader
let strokesFailed = 0;               // Total strokes that failed to forward

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

// ── WebSocket Safety Helper ───────────────────────────────────────────────

/**
 * Safely send message to WebSocket client
 * Checks connection state before sending to prevent crashes
 * @param {WebSocket} ws - WebSocket connection
 * @param {object} data - Data to send
 * @returns {boolean} - True if sent, false if failed
 */
function safeSend(ws, data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return false;
    }
    
    try {
        ws.send(JSON.stringify(data));
        return true;
    } catch (error) {
        logError("Failed to send WebSocket message", error);
        return false;
    }
}

// ── Leader Discovery ───────────────────────────────────────────────────────

/**
 * Fetch status from a single replica with timeout
 * @param {string} url - Replica URL
 * @returns {Promise<object>} Status object with health info
 */
async function fetchReplicaStatus(url) {
    try {
        const response = await axios.get(`${url}/health`, { 
            timeout: 500,  // 500ms timeout
            validateStatus: () => true  // Don't throw on non-200
        });
        
        if (response.status === 200 && response.data) {
            return {
                url,
                healthy: true,
                ...response.data
            };
        }
        
        return {
            url,
            healthy: false,
            error: `HTTP ${response.status}`
        };
    } catch (error) {
        return {
            url,
            healthy: false,
            error: error.code || error.message
        };
    }
}

/**
 * Poll all replicas and discover who the current leader is
 * @returns {Promise<string|null>} Leader URL or null if no leader found
 */
async function discoverLeader() {
    logInfo("Starting leader discovery", { replicas: REPLICA_URLS });
    
    // Poll all replicas in parallel
    const statusPromises = REPLICA_URLS.map(url => fetchReplicaStatus(url));
    const statuses = await Promise.all(statusPromises);
    
    // Filter healthy replicas
    const healthyReplicas = statuses.filter(s => s.healthy);
    
    logInfo("Received replica statuses", { 
        total: statuses.length,
        healthy: healthyReplicas.length
    });
    
    // Find replica reporting as leader
    const leaderReplica = healthyReplicas.find(s => s.role === "leader");
    
    if (leaderReplica) {
        knownLeaderUrl = leaderReplica.url;
        knownLeaderId = leaderReplica.replicaId;
        
        logInfo("Leader discovered", { 
            leaderId: knownLeaderId,
            leaderUrl: knownLeaderUrl,
            term: leaderReplica.term
        });
        
        return knownLeaderUrl;
    }
    
    // No leader found - check if any replica knows who the leader is
    const replicaWithLeaderInfo = healthyReplicas.find(s => s.leader);
    
    if (replicaWithLeaderInfo && replicaWithLeaderInfo.leader) {
        // Try to find that leader's URL
        const leaderIdFromReplica = replicaWithLeaderInfo.leader;
        const possibleLeader = healthyReplicas.find(
            s => s.replicaId === leaderIdFromReplica
        );
        
        if (possibleLeader) {
            knownLeaderUrl = possibleLeader.url;
            knownLeaderId = possibleLeader.replicaId;
            
            logInfo("Leader found via hint", { 
                leaderId: knownLeaderId,
                leaderUrl: knownLeaderUrl
            });
            
            return knownLeaderUrl;
        }
    }
    
    // No leader available
    knownLeaderUrl = null;
    knownLeaderId = null;
    
    logInfo("No leader found", { 
        healthyReplicas: healthyReplicas.length,
        inElection: healthyReplicas.some(s => s.role === "candidate")
    });
    
    return null;
}

/**
 * Ensure we know the current leader URL
 * @returns {Promise<string|null>} Leader URL or null
 */
async function ensureLeaderUrl() {
    // If we have a cached leader, return it
    if (knownLeaderUrl) {
        return knownLeaderUrl;
    }
    
    // Otherwise discover the leader
    return await discoverLeader();
}

// ── Stroke Forwarding to Leader ───────────────────────────────────────────

/**
 * Forward a stroke to the current leader replica
 * @param {object} strokeData - Stroke data from client
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<object>} Response from leader or error
 */
async function forwardStrokeToLeader(strokeData, maxRetries = 3) {
    let attempts = 0;
    let lastError = null;
    
    while (attempts < maxRetries) {
        attempts++;
        
        try {
            // Ensure we know who the leader is
            const leaderUrl = await ensureLeaderUrl();
            
            if (!leaderUrl) {
                logInfo("No leader available, retrying", { 
                    attempt: attempts, 
                    maxRetries 
                });
                
                // Wait before retry with exponential backoff
                const backoff = 200 * Math.pow(2, attempts - 1);
                await new Promise(resolve => setTimeout(resolve, backoff));
                
                // Force rediscovery on next attempt (clear both cached fields)
                knownLeaderUrl = null;
                knownLeaderId = null;
                continue;
            }
            
            // Forward stroke to leader's /client-stroke endpoint
            logInfo("Forwarding stroke to leader", { 
                leaderId: knownLeaderId,
                attempt: attempts
            });
            
            const response = await axios.post(
                `${leaderUrl}/client-stroke`,
                strokeData,
                { timeout: 1000 }
            );
            
            if (response.status === 200) {
                strokesForwarded++;
                logInfo("Stroke forwarded successfully", { 
                    leaderId: knownLeaderId,
                    strokeCount: strokesForwarded
                });
                
                return { success: true, data: response.data };
            }
            
            throw new Error(`Leader returned status ${response.status}`);
            
        } catch (error) {
            lastError = error;
            
            logError(`Failed to forward stroke (attempt ${attempts})`, error);
            
            // Leader might have changed, force rediscovery
            knownLeaderUrl = null;
            knownLeaderId = null;
            
            if (attempts < maxRetries) {
                // Wait before retry with exponential backoff
                const backoff = 300 * Math.pow(2, attempts - 1);
                await new Promise(resolve => setTimeout(resolve, backoff));
            }
        }
    }
    
    // All retries exhausted
    strokesFailed++;
    logError("Failed to forward stroke after all retries", lastError);
    
    return { 
        success: false, 
        error: lastError.message || "Unknown error",
        retriesExhausted: true
    };
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

    // Send welcome message (safe send)
    safeSend(ws, {
        type: "welcome",
        message: "Connected to Mini-RAFT Gateway",
        clientId: clientId
    });

    // Handle incoming messages from browser
    ws.on("message", async (rawMessage) => {
        try {
            messageCount++;
            const message = JSON.parse(rawMessage.toString());
            
            logInfo("Message received from client", { 
                clientId, 
                type: message.type,
                messageNumber: messageCount 
            });

            // Day 2: Forward strokes to leader (not just echo)
            if (message.type === "stroke" || message.type === "test") {
                // Prepare stroke data for leader
                const strokeData = {
                    type: message.type,
                    stroke: message.stroke || message.content,
                    timestamp: Date.now(),
                    clientId: clientId
                };
                
                // Forward to leader
                const result = await forwardStrokeToLeader(strokeData);
                
                if (result.success) {
                    // Acknowledge to sender (safe send - check connection state)
                    safeSend(ws, {
                        type: "ack",
                        message: "Stroke forwarded to leader",
                        leaderId: knownLeaderId,
                        timestamp: Date.now()
                    });
                } else {
                    // Notify sender of failure (safe send - check connection state)
                    safeSend(ws, {
                        type: "error",
                        message: "Failed to forward stroke to leader",
                        error: result.error,
                        retry: true
                    });
                }
            } else {
                // Other message types - echo back for now (safe send)
                safeSend(ws, {
                    type: "echo",
                    original: message,
                    timestamp: Date.now()
                });
            }

        } catch (error) {
            logError("Failed to process client message", error);
            // Safe send - connection may have closed during error
            safeSend(ws, {
                type: "error",
                message: "Failed to process message"
            });
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
        strokesForwarded: strokesForwarded,
        strokesFailed: strokesFailed,
        knownLeader: knownLeaderId,
        knownLeaderUrl: knownLeaderUrl,
        uptime: process.uptime()
    });
});

// Leader discovery endpoint (manual trigger)
app.get("/discover-leader", async (req, res) => {
    try {
        const leaderUrl = await discoverLeader();
        res.json({
            success: !!leaderUrl,
            leaderUrl: leaderUrl,
            leaderId: knownLeaderId,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
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

// Serve Day 2 test page
app.get("/test", (req, res) => {
    res.sendFile(__dirname + "/test-day2.html");
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
    console.log("  Mini-RAFT Gateway Server - Day 2: Leader Discovery");
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
