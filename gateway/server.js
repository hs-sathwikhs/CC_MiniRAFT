const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = Number(process.env.PORT || 8080);
const REPLICA_URLS = (process.env.REPLICA_URLS || "http://localhost:5001,http://localhost:5002,http://localhost:5003").split(",").map((url) => url.trim()).filter(Boolean);
const TIMEOUTS = {
    REPLICA_STATUS_CHECK: Number(process.env.TIMEOUT_REPLICA_STATUS || 500),
    STROKE_FORWARD: Number(process.env.TIMEOUT_STROKE_FORWARD || 10000),
    CLEAR_FORWARD: Number(process.env.TIMEOUT_CLEAR_FORWARD || 10000),
    COMMIT_POLLING: Number(process.env.TIMEOUT_COMMIT_POLLING || 5000),
    LEADER_CACHE_TTL: Number(process.env.LEADER_CACHE_TTL || 1000),
};
let rateLimitHits = 0;
let committedStrokeIds = new Set();
let lastCommitIndex = -1;
let strokeHistory = [];
let validationFailures = 0;
const MAX_STROKE_HISTORY = 10000;
let knownLeaderUrl = null;           
let knownLeaderId = null;            
let connectedClients = new Set();    
let messageCount = 0;                
let broadcastCount = 0;              
let strokesForwarded = 0;            
let strokesFailed = 0;               
let clearsForwarded = 0;
let clearsFailed = 0;
function validateStroke(stroke) {
    if (!stroke || typeof stroke !== 'object') {
        return { valid: false, error: "Stroke must be an object" };
    }
    const required = ['x0', 'y0', 'x1', 'y1'];
    for (const field of required) {
        if (!Number.isFinite(stroke[field])) {
            return { valid: false, error: `${field} must be a finite number` };
        }
        if (Math.abs(stroke[field]) > 100000) {
            return { valid: false, error: `${field} exceeds coordinate limit` };
        }
    }
    if (stroke.width !== undefined) {
        if (!Number.isFinite(stroke.width) || stroke.width < 1 || stroke.width > 100) {
            return { valid: false, error: "Width must be between 1 and 100" };
        }
    }
    if (stroke.color !== undefined) {
        if (typeof stroke.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(stroke.color)) {
            return { valid: false, error: "Color must be in #RRGGBB format" };
        }
    }
    if (stroke.tool !== undefined) {
        if (typeof stroke.tool !== 'string' || !['pen', 'eraser'].includes(stroke.tool)) {
            return { valid: false, error: "Tool must be 'pen' or 'eraser'" };
        }
    }
    return { valid: true };
}
function validateClear(data) {
    if (data && typeof data !== 'object') {
        return { valid: false, error: "Clear data must be an object" };
    }
    return { valid: true };
}
function sanitizeError(error) {
    if (!error) return "An error occurred";
    const errorStr = error.toString();
    let sanitized = errorStr.replace(/https?:\/\/[^\s]+/g, "[REDACTED_URL]");
    sanitized = sanitized.replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, "[REDACTED_IP]");
    sanitized = sanitized.split('\n')[0];
    if (sanitized.includes("ECONNREFUSED")) return "Service temporarily unavailable";
    if (sanitized.includes("ETIMEDOUT")) return "Request timeout";
    if (sanitized.includes("ENOTFOUND")) return "Service not found";
    return sanitized.substring(0, 200); 
}
function logInfo(message, data = {}) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [GATEWAY] ${message}`, 
        Object.keys(data).length > 0 ? JSON.stringify(data) : "");
}
function logError(message, error) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [GATEWAY] ERROR: ${message}`, error.message || error);
}
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
async function fetchReplicaStatus(url) {
    try {
        const response = await axios.get(`${url}/health`, {
            timeout: TIMEOUTS.REPLICA_STATUS_CHECK,
            validateStatus: () => true  
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
async function discoverLeader() {
    logInfo("Starting leader discovery", { replicas: REPLICA_URLS });
    const statusPromises = REPLICA_URLS.map(url => fetchReplicaStatus(url));
    const statuses = await Promise.all(statusPromises);
    const healthyReplicas = statuses.filter(s => s.healthy);
    logInfo("Received replica statuses", { 
        total: statuses.length,
        healthy: healthyReplicas.length
    });
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
    const replicaWithLeaderInfo = healthyReplicas.find(s => s.leader);
    if (replicaWithLeaderInfo && replicaWithLeaderInfo.leader) {
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
    knownLeaderUrl = null;
    knownLeaderId = null;
    logInfo("No leader found", { 
        healthyReplicas: healthyReplicas.length,
        inElection: healthyReplicas.some(s => s.role === "candidate")
    });
    return null;
}
async function ensureLeaderUrl() {
    if (knownLeaderUrl) {
        return knownLeaderUrl;
    }
    return await discoverLeader();
}
async function forwardStrokeToLeader(strokeData, maxRetries = 3) {
    let attempts = 0;
    let lastError = null;
    while (attempts < maxRetries) {
        attempts++;
        try {
            const leaderUrl = await ensureLeaderUrl();
            if (!leaderUrl) {
                logInfo("No leader available, retrying", { 
                    attempt: attempts, 
                    maxRetries 
                });
                const backoff = 200 * Math.pow(2, attempts - 1);
                await new Promise(resolve => setTimeout(resolve, backoff));
                knownLeaderUrl = null;
                knownLeaderId = null;
                continue;
            }
            logInfo("Forwarding stroke to leader", { 
                leaderId: knownLeaderId,
                attempt: attempts
            });
            const response = await axios.post(
                `${leaderUrl}/stroke`,
                { stroke: strokeData.stroke },  
                { timeout: TIMEOUTS.STROKE_FORWARD }
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
            knownLeaderUrl = null;
            knownLeaderId = null;
            if (attempts < maxRetries) {
                const backoff = 300 * Math.pow(2, attempts - 1);
                await new Promise(resolve => setTimeout(resolve, backoff));
            }
        }
    }
    strokesFailed++;
    logError("Failed to forward stroke after all retries", lastError);
    return { 
        success: false, 
        error: lastError.message || "Unknown error",
        retriesExhausted: true
    };
}
async function forwardClearToLeader(clearData = {}, maxRetries = 3) {
    let attempts = 0;
    let lastError = null;
    while (attempts < maxRetries) {
        attempts++;
        try {
            const leaderUrl = await ensureLeaderUrl();
            if (!leaderUrl) {
                logInfo("No leader available for clear, retrying", { 
                    attempt: attempts, 
                    maxRetries 
                });
                const backoff = 200 * Math.pow(2, attempts - 1);
                await new Promise(resolve => setTimeout(resolve, backoff));
                knownLeaderUrl = null;
                knownLeaderId = null;
                continue;
            }
            logInfo("Forwarding clear to leader", { 
                leaderId: knownLeaderId,
                attempt: attempts
            });
            const response = await axios.post(
                `${leaderUrl}/clear`,
                { clientId: clearData.clientId || "unknown" },
                { timeout: TIMEOUTS.CLEAR_FORWARD }
            );
            if (response.status === 200) {
                clearsForwarded++;
                logInfo("Clear forwarded successfully", { 
                    leaderId: knownLeaderId,
                    clearCount: clearsForwarded
                });
                return { success: true, data: response.data };
            }
            throw new Error(`Leader returned status ${response.status}`);
        } catch (error) {
            lastError = error;
            logError(`Failed to forward clear (attempt ${attempts})`, error);
            knownLeaderUrl = null;
            knownLeaderId = null;
            if (attempts < maxRetries) {
                const backoff = 300 * Math.pow(2, attempts - 1);
                await new Promise(resolve => setTimeout(resolve, backoff));
            }
        }
    }
    clearsFailed++;
    logError("Failed to forward clear after all retries", lastError);
    return { 
        success: false, 
        error: lastError.message || "Unknown error",
        retriesExhausted: true
    };
}
function broadcastStroke(stroke) {
    const message = {
        type: "stroke",
        stroke: stroke
    };
    let successCount = 0;
    connectedClients.forEach(ws => {
        if (safeSend(ws, message)) {
            successCount++;
        }
    });
    broadcastCount++;
    logInfo("Broadcasted stroke to clients", { 
        successCount, 
        totalClients: connectedClients.size 
    });
}
wss.on("connection", (ws, req) => {
    const clientId = `client-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    connectedClients.add(ws);
    logInfo("New client connected", { 
        clientId, 
        totalClients: connectedClients.size,
        ip: req.socket.remoteAddress 
    });
    safeSend(ws, {
        type: "welcome",
        message: "Connected to Mini-RAFT Gateway",
        clientId: clientId
    });
    if (strokeHistory.length > 0) {
        safeSend(ws, {
            type: "full-log",
            strokes: strokeHistory,
            count: strokeHistory.length
        });
        logInfo("Sent full-log to new client", { 
            clientId, 
            strokeCount: strokeHistory.length 
        });
    }
    ws.on("message", async (rawMessage) => {
        try {
            messageCount++;
            const message = JSON.parse(rawMessage.toString());
            logInfo("Message received from client", { 
                clientId, 
                type: message.type,
                messageNumber: messageCount 
            });
            if (message.type === "stroke" || message.type === "test") {
                const validation = validateStroke(message.stroke || message.content);
                if (!validation.valid) {
                    validationFailures++;
                    safeSend(ws, {
                        type: "error",
                        message: validation.error,
                        validation: false
                    });
                    logInfo("Stroke validation failed", { 
                        clientId, 
                        error: validation.error,
                        totalFailures: validationFailures 
                    });
                    return;
                }
                const strokeData = {
                    type: message.type,
                    stroke: message.stroke || message.content,
                    timestamp: Date.now(),
                    clientId: clientId
                };
                const result = await forwardStrokeToLeader(strokeData);
                if (result.success) {
                    const entry = (result.data && result.data.entry) ? result.data.entry : null;
                    if (entry && entry.stroke) {
                        const strokeId = entry.term + "-" + entry.index;
                        // State will be updated when the Replica calls /broadcast
                    } else {
                        // State will be updated when the Replica calls /broadcast
                    }
                    safeSend(ws, {
                        type: "ack",
                        message: "Stroke forwarded to leader",
                        leaderId: knownLeaderId,
                        timestamp: Date.now()
                    });
                } else {
                    safeSend(ws, {
                        type: "error",
                        message: "Failed to forward stroke to leader",
                        error: sanitizeError(result.error),
                        retry: true
                    });
                }
            } 
            else if (message.type === "clear") {
                const validation = validateClear(message.data);
                if (!validation.valid) {
                    validationFailures++;
                    safeSend(ws, {
                        type: "error",
                        message: validation.error,
                        validation: false
                    });
                    logInfo("Clear validation failed", { 
                        clientId, 
                        error: validation.error 
                    });
                    return;
                }
                const clearData = {
                    clientId: clientId,
                    timestamp: Date.now()
                };
                const result = await forwardClearToLeader(clearData);
                if (result.success) {
                    const entry = (result.data && result.data.entry) ? result.data.entry : null;
                    if (entry && entry.stroke) {
                        const strokeId = entry.term + "-" + entry.index;
                        // State will be updated when the Replica calls /broadcast
                    } else {
                        // State will be updated when the Replica calls /broadcast
                    }
                    safeSend(ws, {
                        type: "ack",
                        message: "Clear command forwarded to leader",
                        leaderId: knownLeaderId,
                        timestamp: Date.now()
                    });
                    logInfo("Clear command forwarded", { 
                        clientId,
                        leaderId: knownLeaderId 
                    });
                } else {
                    safeSend(ws, {
                        type: "error",
                        message: "Failed to forward clear command",
                        error: sanitizeError(result.error),
                        retry: true
                    });
                }
            }
            else {
                safeSend(ws, {
                    type: "echo",
                    original: message,
                    timestamp: Date.now()
                });
            }
        } catch (error) {
            logError("Failed to process client message", error);
            safeSend(ws, {
                type: "error",
                message: "Failed to process message"
            });
        }
    });
    ws.on("close", () => {
        connectedClients.delete(ws);
        logInfo("Client disconnected", { 
            clientId, 
            remainingClients: connectedClients.size 
        });
    });
    ws.on("error", (error) => {
        logError(`WebSocket error for ${clientId}`, error);
        connectedClients.delete(ws);
    });
});
app.post("/broadcast", (req, res) => {
    const { stroke, term, index } = req.body;
    if (!stroke) {
        return res.status(400).json({ error: "Missing stroke data" });
    }
    const strokeId = term + "-" + index;
    if (term !== undefined && index !== undefined && !committedStrokeIds.has(strokeId)) {
        committedStrokeIds.add(strokeId);
        
        if (stroke.kind === "clear") {
            strokeHistory = [];
        } else {
            strokeHistory.push(stroke);
            if (strokeHistory.length > MAX_STROKE_HISTORY) {
                strokeHistory.splice(0, strokeHistory.length - MAX_STROKE_HISTORY);
            }
        }
        
        if (index > lastCommitIndex) {
            lastCommitIndex = index;
        }
    }
    broadcastStroke(stroke);
    return res.json({ success: true, broadcasted: true });
});
app.get("/health", (req, res) => {
    res.json({
        status: "healthy",
        service: "miniraft-gateway",
        connectedClients: connectedClients.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});
app.get("/stats", (req, res) => {
    res.json({

        connectedClients: connectedClients.size,
        totalMessagesReceived: messageCount,
        totalBroadcasts: broadcastCount,
        strokesForwarded: strokesForwarded,
        strokesFailed: strokesFailed,
        clearsForwarded: clearsForwarded,
        clearsFailed: clearsFailed,
        knownLeader: knownLeaderId,
        knownLeaderUrl: knownLeaderUrl,
        committedStrokesSeen: committedStrokeIds.size,
        lastCommitIndex: lastCommitIndex,
        strokeHistorySize: strokeHistory.length,
        validationFailures: validationFailures,
        uptime: process.uptime()
    });
});
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
app.get("/dashboard", (req, res) => {
    res.sendFile(__dirname + "/public/dashboard.html");
});
app.get("/api/metrics", async (req, res) => {
    const replicaStatuses = await Promise.all(
        REPLICA_URLS.map(url => fetchReplicaStatus(url))
    );
    res.json({
        connectedClients: connectedClients.size,
        totalMessagesReceived: messageCount,
        totalBroadcasts: broadcastCount,
        strokesForwarded: strokesForwarded,
        strokesFailed: strokesFailed,
        clearsForwarded: clearsForwarded,
        clearsFailed: clearsFailed,
        committedStrokesSeen: committedStrokeIds.size,
        lastCommitIndex: lastCommitIndex,
        strokeHistorySize: strokeHistory.length,
        validationFailures: validationFailures,
        rateLimitHits: rateLimitHits,
        uptime: process.uptime(),
        replicaStatuses: replicaStatuses,
        timestamp: new Date().toISOString()
    });
});
app.get("/", (req, res) => { res.redirect("/dashboard"); });
app.get("/test", (req, res) => {
    res.redirect("/");
});
server.listen(PORT, () => {
    logInfo("Gateway started", { port: PORT, replicas: REPLICA_URLS, webSocketReady: true });
});
process.on("SIGTERM", () => {
    logInfo("Received SIGTERM, shutting down gracefully");
    server.close(() => {
        logInfo("Server closed");
        process.exit(0);
    });
    setTimeout(() => {
        logError("Graceful shutdown timeout - forcing exit", new Error("Shutdown timeout"));
        process.exit(1);
    }, 5000);
});
process.on("SIGINT", () => {
    logInfo("Received SIGINT, shutting down gracefully");
    server.close(() => {
        logInfo("Server closed");
        process.exit(0);
    });
    setTimeout(() => {
        logError("Graceful shutdown timeout - forcing exit", new Error("Shutdown timeout"));
        process.exit(1);
    }, 5000);
});
