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
app.use(express.static("public"));

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

// Timeout configurations (in milliseconds)
const TIMEOUTS = {
    REPLICA_STATUS_CHECK: Number(process.env.TIMEOUT_REPLICA_STATUS || 500),
    STROKE_FORWARD: Number(process.env.TIMEOUT_STROKE_FORWARD || 10000),
    CLEAR_FORWARD: Number(process.env.TIMEOUT_CLEAR_FORWARD || 10000),
    COMMIT_POLLING: Number(process.env.TIMEOUT_COMMIT_POLLING || 5000),
    LEADER_CACHE_TTL: Number(process.env.LEADER_CACHE_TTL || 1000),
};

// Rate limiting config
const RATE_LIMIT_CONFIG = {
    MAX_REQUESTS_PER_SECOND: Number(process.env.MAX_REQUESTS_PER_SECOND || 1000),
    MAX_VIOLATIONS: Number(process.env.MAX_VIOLATIONS || 100),
    VIOLATION_RESET_TIME: Number(process.env.VIOLATION_RESET_TIME || 60000),
};

// ── State ──────────────────────────────────────────────────────────────────
let knownLeaderUrl = null;           // Cached leader URL
let knownLeaderId = null;            // Cached leader replica ID
let connectedClients = new Set();    // Set of connected WebSocket clients
let messageCount = 0;                // Total messages received
let broadcastCount = 0;              // Total broadcasts sent
let strokesForwarded = 0;            // Total strokes forwarded to leader
let strokesFailed = 0;               // Total strokes that failed to forward

// Day 3: Broadcasting state
let committedStrokeIds = new Set();  // Track seen stroke IDs for deduplication
let lastCommitIndex = -1;            // Last commit index we've seen
let strokeHistory = [];              // Cache of all committed strokes for new clients
let pollingInterval = null;          // Interval handle for commit polling
let isPolling = false;               // In-flight guard for commit polling

// Day 4: Failover & health monitoring
let healthCheckInterval = null;      // Interval handle for leader health checks
let initialHealthTimeout = null;     // Timeout handle for initial health check
let leaderFailureCount = 0;          // Consecutive leader health check failures
let lastHealthCheck = null;          // Timestamp of last successful health check
const MAX_LEADER_FAILURES = 2;       // Leader is considered down after this many failures

// Memory management
const MAX_STROKE_HISTORY = Number(process.env.MAX_STROKE_HISTORY || 10000);     // Cap stroke history to prevent unbounded growth

// Rate limiting
const rateLimits = new Map();        // clientId -> { count, resetTime, violations }
const MAX_REQUESTS_PER_SECOND = RATE_LIMIT_CONFIG.MAX_REQUESTS_PER_SECOND;
const MAX_VIOLATIONS = RATE_LIMIT_CONFIG.MAX_VIOLATIONS;
const VIOLATION_RESET_TIME = RATE_LIMIT_CONFIG.VIOLATION_RESET_TIME;
const RATE_LIMIT_CLEANUP_INTERVAL = 60000; // Sweep expired rate-limit state once per minute

/**
 * Remove expired rate-limit state so disconnected clients do not accumulate
 * in memory indefinitely.
 */
function evictExpiredRateLimits(now = Date.now()) {
    for (const [clientId, state] of rateLimits.entries()) {
        if (!state || typeof state !== "object") {
            rateLimits.delete(clientId);
            continue;
        }

        const requestWindowExpired =
            typeof state.resetTime !== "number" || state.resetTime <= now;

        if (requestWindowExpired) {
            rateLimits.delete(clientId);
        }
    }
}

const rateLimitCleanupInterval = setInterval(
    () => evictExpiredRateLimits(),
    RATE_LIMIT_CLEANUP_INTERVAL
);
if (typeof rateLimitCleanupInterval.unref === "function") {
    rateLimitCleanupInterval.unref();
}
// Validation statistics
let validationFailures = 0;
let rateLimitHits = 0;
let clearsForwarded = 0;
let clearsFailed = 0;

// ── Input Validation ───────────────────────────────────────────────────────

/**
 * Validate stroke data
 * @param {object} stroke - Stroke object to validate
 * @returns {object} { valid: boolean, error?: string }
 */
function validateStroke(stroke) {
    if (!stroke || typeof stroke !== 'object') {
        return { valid: false, error: "Stroke must be an object" };
    }
    
    // Required coordinate fields
    const required = ['x0', 'y0', 'x1', 'y1'];
    for (const field of required) {
        if (!Number.isFinite(stroke[field])) {
            return { valid: false, error: `${field} must be a finite number` };
        }
        
        // Reasonable coordinate range (prevent DoS via huge numbers)
        if (Math.abs(stroke[field]) > 100000) {
            return { valid: false, error: `${field} exceeds coordinate limit` };
        }
    }
    
    // Optional width validation
    if (stroke.width !== undefined) {
        if (!Number.isFinite(stroke.width) || stroke.width < 1 || stroke.width > 100) {
            return { valid: false, error: "Width must be between 1 and 100" };
        }
    }
    
    // Optional color validation (hex color format)
    if (stroke.color !== undefined) {
        if (typeof stroke.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(stroke.color)) {
            return { valid: false, error: "Color must be in #RRGGBB format" };
        }
    }
    
    // Optional tool validation
    if (stroke.tool !== undefined) {
        if (typeof stroke.tool !== 'string' || !['pen', 'eraser'].includes(stroke.tool)) {
            return { valid: false, error: "Tool must be 'pen' or 'eraser'" };
        }
    }
    
    return { valid: true };
}

/**
 * Validate clear command data
 * @param {object} data - Clear command data
 * @returns {object} { valid: boolean, error?: string }
 */
function validateClear(data) {
    // Clear command can have optional clientId but no other required fields
    if (data && typeof data !== 'object') {
        return { valid: false, error: "Clear data must be an object" };
    }
    return { valid: true };
}

/**
 * Check if client is rate limited
 * @param {string} clientId - Client identifier
 * @returns {boolean} True if rate limited
 */
function isRateLimited(clientId) {
    const now = Date.now();
    const limit = rateLimits.get(clientId) || {
        count: 0,
        resetTime: now + 1000
    };

    // Reset count if time window elapsed
    if (now > limit.resetTime) {
        limit.count = 0;
        limit.resetTime = now + 1000;
    }

    limit.count++;
    rateLimits.set(clientId, limit);

    // Check if over limit
    if (limit.count > MAX_REQUESTS_PER_SECOND) {
        return true;
    }

    return false;
}

/**
 * Sanitize error messages to avoid leaking internal details
 * @param {string} error - Original error message
 * @returns {string} Sanitized error message
 */
function sanitizeError(error) {
    if (!error) return "An error occurred";
    
    const errorStr = error.toString();
    
    // Remove internal URLs and IPs
    let sanitized = errorStr.replace(/https?:\/\/[^\s]+/g, "[REDACTED_URL]");
    sanitized = sanitized.replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, "[REDACTED_IP]");
    
    // Remove stack traces
    sanitized = sanitized.split('\n')[0];
    
    // Generic message for common errors
    if (sanitized.includes("ECONNREFUSED")) return "Service temporarily unavailable";
    if (sanitized.includes("ETIMEDOUT")) return "Request timeout";
    if (sanitized.includes("ENOTFOUND")) return "Service not found";
    
    return sanitized.substring(0, 200); // Limit length
}

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
            timeout: TIMEOUTS.REPLICA_STATUS_CHECK,
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
            
            // Forward stroke to leader's /stroke endpoint (Day 3: Fixed endpoint)
            logInfo("Forwarding stroke to leader", { 
                leaderId: knownLeaderId,
                attempt: attempts
            });
            
            const response = await axios.post(
                `${leaderUrl}/stroke`,
                { stroke: strokeData.stroke },  // Replica expects { stroke: {...} }
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

/**
 * Forward a clear command to the current leader replica
 * @param {object} clearData - Clear command data from client
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<object>} Response from leader or error
 */
async function forwardClearToLeader(clearData = {}, maxRetries = 3) {
    let attempts = 0;
    let lastError = null;
    
    while (attempts < maxRetries) {
        attempts++;
        
        try {
            // Ensure we know who the leader is
            const leaderUrl = await ensureLeaderUrl();
            
            if (!leaderUrl) {
                logInfo("No leader available for clear, retrying", { 
                    attempt: attempts, 
                    maxRetries 
                });
                
                // Wait before retry with exponential backoff
                const backoff = 200 * Math.pow(2, attempts - 1);
                await new Promise(resolve => setTimeout(resolve, backoff));
                
                // Force rediscovery on next attempt
                knownLeaderUrl = null;
                knownLeaderId = null;
                continue;
            }
            
            // Forward clear to leader's /clear endpoint
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
    clearsFailed++;
    logError("Failed to forward clear after all retries", lastError);
    
    return { 
        success: false, 
        error: lastError.message || "Unknown error",
        retriesExhausted: true
    };
}

// ── Day 3: Broadcasting Committed Entries ──────────────────────────────────

/**
 * Broadcast stroke to all connected WebSocket clients
 * @param {object} stroke - Stroke data to broadcast
 */
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

/**
 * Poll for newly committed entries from the leader
 * Runs periodically to detect new commits and broadcast them
 * Uses in-flight guard to prevent overlapping requests
 */
async function pollCommittedEntries() {
    // In-flight guard: prevent overlapping polls
    if (isPolling) {
        return;
    }
    
    isPolling = true;
    
    try {
        // Ensure we know who the leader is
        const leaderUrl = await ensureLeaderUrl();
        if (!leaderUrl) {
            return; // No leader available, will retry next poll
        }
        
        // Fetch committed entries from the leader
        // Use 'from' query parameter (matches replica API)
        const response = await axios.get(
            `${leaderUrl}/committed?from=${lastCommitIndex + 1}`,
            { timeout: TIMEOUTS.COMMIT_POLLING }
        );
        
        // Validate response structure
        if (!response.data || typeof response.data !== 'object') {
            logError("Invalid /committed response: not an object", new Error("Invalid response"));
            return;
        }
        
        if (!Array.isArray(response.data.entries)) {
            logError("Invalid /committed response: entries not an array", new Error("Invalid response"));
            return;
        }
        
        if (typeof response.data.commitIndex !== 'number') {
            logError("Invalid /committed response: commitIndex not a number", new Error("Invalid response"));
            return;
        }
        
        const newEntries = response.data.entries;
        
        // Process each new committed entry
        for (const entry of newEntries) {
            // Validate entry structure
            if (!entry || typeof entry !== 'object') {
                logError("Invalid entry in /committed response", new Error("Invalid entry"));
                continue;
            }
            
            if (typeof entry.term !== 'number' || typeof entry.index !== 'number') {
                logError("Entry missing term or index", new Error("Invalid entry"));
                continue;
            }
            
            if (!entry.stroke || typeof entry.stroke !== 'object') {
                logError("Entry missing stroke data", new Error("Invalid entry"));
                continue;
            }
            
            // Generate unique ID for deduplication
            const strokeId = `${entry.term}-${entry.index}`;
            
            // Skip if we've already seen this stroke
            if (committedStrokeIds.has(strokeId)) {
                continue;
            }
            
            // Mark as seen and add to history
            committedStrokeIds.add(strokeId);
            strokeHistory.push(entry.stroke);
            
            // Update last seen commit index
            if (entry.index > lastCommitIndex) {
                lastCommitIndex = entry.index;
            }
            
            // Broadcast to all connected clients
            broadcastStroke(entry.stroke);
            
            logInfo("New commit detected and broadcasted", {
                index: entry.index,
                term: entry.term,
                commitIndex: response.data.commitIndex
            });
        }
        
        // Memory management: cap history size
        if (strokeHistory.length > MAX_STROKE_HISTORY) {
            const excess = strokeHistory.length - MAX_STROKE_HISTORY;
            strokeHistory.splice(0, excess);
            
            logInfo("Trimmed stroke history", {
                removed: excess,
                currentSize: strokeHistory.length
            });
            
            // Note: committedStrokeIds Set will continue to grow,
            // but IDs are small strings so memory impact is minimal
        }
        
    } catch (error) {
        // Day 4: Enhanced error handling for leader failures
        if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
            // Leader might be down - health check will handle rediscovery
            // Don't spam logs during normal elections
        } else if (error.response && error.response.status === 404) {
            // Endpoint not found - might be talking to wrong replica
            logError("Committed endpoint not found on leader", error);
            knownLeaderUrl = null;
            knownLeaderId = null;
        } else {
            // Unexpected error
            logError("Error polling committed entries", error);
        }
    } finally {
        // Always clear the in-flight flag
        isPolling = false;
    }
}

/**
 * Start polling for committed entries
 * Polls every 200ms for low-latency updates
 */
function startCommitPolling() {
    if (pollingInterval) {
        return; // Already polling
    }
    
    logInfo("Starting commit polling", { interval: "200ms" });
    
    // Poll immediately on start
    pollCommittedEntries();
    
    // Then poll every 200ms
    pollingInterval = setInterval(pollCommittedEntries, 200);
}

/**
 * Stop polling for committed entries
 */
function stopCommitPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
        logInfo("Stopped commit polling");
    }
}

// ── Day 4: Leader Health Monitoring & Failover ────────────────────────────

/**
 * Perform health check on current known leader
 * Detects leader failures and triggers automatic rediscovery
 */
async function checkLeaderHealth() {
    // Skip if we don't have a known leader
    if (!knownLeaderUrl || !knownLeaderId) {
        return;
    }
    
    try {
        const response = await axios.get(
            `${knownLeaderUrl}/health`,
            { timeout: TIMEOUTS.REPLICA_STATUS_CHECK }
        );
        
        // Verify this replica is still the leader
        if (response.data && response.data.role === 'leader') {
            // Leader is healthy
            leaderFailureCount = 0;
            lastHealthCheck = Date.now();
            
            logInfo("Leader health check passed", {
                leaderId: knownLeaderId,
                term: response.data.term,
                logLength: response.data.logLength
            });
        } else {
            // Replica is no longer the leader
            logInfo("Leader has stepped down", {
                oldLeaderId: knownLeaderId,
                currentRole: response.data.role,
                reportedLeader: response.data.leader
            });
            
            // Force rediscovery
            knownLeaderUrl = null;
            knownLeaderId = null;
            leaderFailureCount = 0;
            
            // Attempt immediate rediscovery
            await discoverLeader();
        }
        
    } catch (error) {
        leaderFailureCount++;
        
        logError(`Leader health check failed (${leaderFailureCount}/${MAX_LEADER_FAILURES})`, error);
        
        // If leader has failed multiple times, force rediscovery
        if (leaderFailureCount >= MAX_LEADER_FAILURES) {
            logInfo("Leader appears to be down - forcing rediscovery", {
                oldLeaderId: knownLeaderId,
                failureCount: leaderFailureCount
            });
            
            // Clear cached leader
            knownLeaderUrl = null;
            knownLeaderId = null;
            leaderFailureCount = 0;
            
            // Attempt to discover new leader
            try {
                await discoverLeader();
                logInfo("New leader discovered after failover");
            } catch (discoveryError) {
                logError("Failed to discover new leader - cluster may be in election", discoveryError);
            }
        }
    }
}

/**
 * Start periodic leader health monitoring
 * Checks leader health every 5 seconds
 */
function startHealthMonitoring() {
    if (healthCheckInterval) {
        return; // Already monitoring
    }
    
    logInfo("Starting leader health monitoring", { interval: "5s" });
    
    // Perform initial health check after 5 seconds
    initialHealthTimeout = setTimeout(checkLeaderHealth, 5000);
    
    // Then check every 5 seconds
    healthCheckInterval = setInterval(checkLeaderHealth, 5000);
}

/**
 * Stop leader health monitoring
 */
function stopHealthMonitoring() {
    // Clear the interval
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
    }
    
    // Clear the initial timeout if it hasn't fired yet
    if (initialHealthTimeout) {
        clearTimeout(initialHealthTimeout);
        initialHealthTimeout = null;
    }
    
    logInfo("Stopped health monitoring");
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

    // Day 3: Send full stroke history for synchronization
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

            // Rate limiting check
            if (isRateLimited(clientId)) {
                rateLimitHits++;
                safeSend(ws, {
                    type: "error",
                    message: "Rate limit exceeded. Please slow down.",
                    rateLimited: true
                });
                logInfo("Client rate limited", { 
                    clientId, 
                    totalRateLimitHits: rateLimitHits 
                });
                return;
            }

            // Handle stroke messages
            if (message.type === "stroke" || message.type === "test") {
                // Validate stroke data
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
                    // Sanitize error message to avoid leaking internal details
                    safeSend(ws, {
                        type: "error",
                        message: "Failed to forward stroke to leader",
                        error: sanitizeError(result.error),
                        retry: true
                    });
                }
            } 
            // Handle clear command
            else if (message.type === "clear") {
                // Validate clear command
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
                
                // Prepare clear data
                const clearData = {
                    clientId: clientId,
                    timestamp: Date.now()
                };
                
                // Forward to leader
                const result = await forwardClearToLeader(clearData);
                
                if (result.success) {
                    // Acknowledge to sender
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
                    // Notify sender of failure (sanitized error)
                    safeSend(ws, {
                        type: "error",
                        message: "Failed to forward clear command",
                        error: sanitizeError(result.error),
                        retry: true
                    });
                }
            }
            // Handle other message types
            else {
                // Echo back for now (safe send)
                safeSend(ws, {
                    type: "echo",
                    original: message,
                    timestamp: Date.now()
                });
            }

        } catch (error) {
            logError("Failed to process client message", error);
            // Safe send - connection may have closed during error
            // Use sanitized error message
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
        clearsForwarded: clearsForwarded,
        clearsFailed: clearsFailed,
        knownLeader: knownLeaderId,
        knownLeaderUrl: knownLeaderUrl,
        // Day 3: Broadcasting stats
        committedStrokesSeen: committedStrokeIds.size,
        lastCommitIndex: lastCommitIndex,
        strokeHistorySize: strokeHistory.length,
        pollingActive: !!pollingInterval,
        // Day 4: Failover stats
        healthMonitoringActive: !!healthCheckInterval,
        leaderFailureCount: leaderFailureCount,
        lastHealthCheck: lastHealthCheck,
        // Security stats
        validationFailures: validationFailures,
        rateLimitHits: rateLimitHits,
        activeRateLimits: rateLimits.size,
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

// Dashboard - Serve real-time metrics UI
app.get("/dashboard", (req, res) => {
    res.sendFile(__dirname + "/public/dashboard.html");
});

// Dashboard API - Return metrics in JSON format
app.get("/api/metrics", async (req, res) => {
    // Fetch replica statuses for cluster info
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
        healthMonitoringActive: !!healthCheckInterval,
        leaderFailureCount: leaderFailureCount,
        validationFailures: validationFailures,
        rateLimitHits: rateLimitHits,
        uptime: process.uptime(),
        replicaStatuses: replicaStatuses,
        timestamp: new Date().toISOString()
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

// Serve Day 2 test page (removed - use frontend instead)
app.get("/test", (req, res) => {
    res.redirect("/");
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
    console.log("  Mini-RAFT Gateway Server - Day 4: Failover Handling");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`  URL: http://localhost:${PORT}`);
    console.log(`  Connected Clients: 0`);
    console.log(`  Replica URLs: ${REPLICA_URLS.join(", ")}`);
    console.log(`  Commit Polling: Every 200ms`);
    console.log(`  Health Monitoring: Every 5s`);
    console.log("═══════════════════════════════════════════════════════════");
    
    // Day 3: Start polling for committed entries
    startCommitPolling();
    
    // Day 4: Start leader health monitoring
    startHealthMonitoring();
    console.log("");
});

// Graceful shutdown
process.on("SIGTERM", () => {
    logInfo("Received SIGTERM, shutting down gracefully");
    
    // Stop monitoring
    stopCommitPolling();
    stopHealthMonitoring();
    
    // Give time for ongoing operations to complete
    server.close(() => {
        logInfo("Server closed");
        process.exit(0);
    });
    
    // Force exit after 5 seconds if graceful shutdown hangs
    setTimeout(() => {
        logError("Graceful shutdown timeout - forcing exit", new Error("Shutdown timeout"));
        process.exit(1);
    }, 5000);
});

process.on("SIGINT", () => {
    logInfo("Received SIGINT, shutting down gracefully");
    
    // Stop monitoring
    stopCommitPolling();
    stopHealthMonitoring();
    
    server.close(() => {
        logInfo("Server closed");
        process.exit(0);
    });
    
    // Force exit after 5 seconds if graceful shutdown hangs
    setTimeout(() => {
        logError("Graceful shutdown timeout - forcing exit", new Error("Shutdown timeout"));
        process.exit(1);
    }, 5000);
});
