const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const app = express();
app.use(express.json());

// ==============================================================================
// MiniRAFT Consensus Implementation - Satwik (Day 1-7 Complete)
// ==============================================================================

// -- Node Identity -------------------------------------------------------------
const REPLICA_ID = process.env.REPLICA_ID || "1";
const PORT = process.env.PORT || 5001;
const RAFT_STATE_FILE = path.join(__dirname, "raft-state.json");

// Detect environment: Docker uses service names, local uses localhost
const IS_DOCKER = process.env.REPLICA_URLS || process.env.DOCKER_ENV;

const REPLICA_HOSTS = IS_DOCKER
    ? { "1": "replica1", "2": "replica2", "3": "replica3" }
    : { "1": "localhost", "2": "localhost", "3": "localhost" };

const REPLICA_PORTS = { "1": 5001, "2": 5002, "3": 5003 };

function getPeerUrls() {
    return Object.keys(REPLICA_HOSTS)
        .filter((id) => id !== REPLICA_ID)
        .map((id) => `http://${REPLICA_HOSTS[id]}:${REPLICA_PORTS[id]}`);
}

const PEERS = getPeerUrls();

// -- RAFT Configuration --------------------------------------------------------
const ELECTION_TIMEOUT_MIN = 500;
const ELECTION_TIMEOUT_MAX = 800;
const HEARTBEAT_INTERVAL = 150;
const MAJORITY = 2;

// -- RAFT State ----------------------------------------------------------------
let state = {
    role: "follower",
    currentTerm: 0,
    votedFor: null,
    log: [],
    commitIndex: -1,
    lastApplied: -1,
    leaderId: null,
};

// Leader-only state
let leaderState = {
    nextIndex: {},
    matchIndex: {},
};

// -- Timers --------------------------------------------------------------------
let electionTimer = null;
let heartbeatInterval = null;

function getRandomTimeout() {
    return Math.floor(Math.random() * (ELECTION_TIMEOUT_MAX - ELECTION_TIMEOUT_MIN)) + ELECTION_TIMEOUT_MIN;
}

function resetElectionTimer() {
    if (electionTimer) clearTimeout(electionTimer);
    const timeout = getRandomTimeout();
    electionTimer = setTimeout(() => {
        if (state.role !== "leader") {
            log("ELECTION", `Election timeout (${timeout}ms) - starting election`);
            startElection();
        }
    }, timeout);
}

function stopElectionTimer() {
    if (electionTimer) {
        clearTimeout(electionTimer);
        electionTimer = null;
    }
}

// -- Logging -------------------------------------------------------------------
function log(category, message) {
    const timestamp = new Date().toISOString().substr(11, 12);
    const roleIcon = state.role === "leader" ? "[LEADER]" : state.role === "candidate" ? "[CAND]" : "[FOLLOWER]";
    console.log(`[${timestamp}] [R${REPLICA_ID}|T${state.currentTerm}|${roleIcon}] [${category}] ${message}`);
}

function normalizePersistedLog(logEntries) {
    if (!Array.isArray(logEntries)) {
        return [];
    }

    const sorted = logEntries
        .filter((entry) => entry && Number.isInteger(entry.index) && entry.index >= 0 && Number.isInteger(entry.term))
        .sort((a, b) => a.index - b.index);

    const normalized = [];
    for (const entry of sorted) {
        if (entry.index !== normalized.length) {
            break;
        }
        normalized.push({ ...entry, committed: Boolean(entry.committed) });
    }

    return normalized;
}

function loadStateFromDisk() {
    try {
        if (!fs.existsSync(RAFT_STATE_FILE)) {
            return;
        }

        const raw = fs.readFileSync(RAFT_STATE_FILE, "utf8");
        const parsed = JSON.parse(raw);

        state.currentTerm = Number.isInteger(parsed.currentTerm) && parsed.currentTerm >= 0 ? parsed.currentTerm : 0;
        state.votedFor = typeof parsed.votedFor === "string" || parsed.votedFor === null ? parsed.votedFor : null;
        state.log = normalizePersistedLog(parsed.log);

        const persistedCommitIndex = Number.isInteger(parsed.commitIndex) ? parsed.commitIndex : -1;
        state.commitIndex = Math.min(Math.max(persistedCommitIndex, -1), state.log.length - 1);
        state.lastApplied = Number.isInteger(parsed.lastApplied)
            ? Math.min(Math.max(parsed.lastApplied, -1), state.commitIndex)
            : state.commitIndex;

        for (let i = 0; i <= state.commitIndex; i++) {
            if (state.log[i]) {
                state.log[i].committed = true;
            }
        }

        log("PERSIST", `Loaded state (term=${state.currentTerm}, logLength=${state.log.length}, commitIndex=${state.commitIndex})`);
    } catch (err) {
        log("PERSIST", `Failed to load state: ${err.message}`);
    }
}

function persistState() {
    try {
        const snapshot = {
            currentTerm: state.currentTerm,
            votedFor: state.votedFor,
            log: state.log,
            commitIndex: state.commitIndex,
            lastApplied: state.lastApplied,
        };

        fs.writeFileSync(RAFT_STATE_FILE, JSON.stringify(snapshot, null, 2), "utf8");
    } catch (err) {
        log("PERSIST", `Failed to save state: ${err.message}`);
    }
}

// -- Step Down -----------------------------------------------------------------
function stepDown(newTerm) {
    if (newTerm > state.currentTerm) {
        log("TERM", `Stepping down: discovered higher term ${newTerm} (was ${state.currentTerm})`);
        state.currentTerm = newTerm;
        state.role = "follower";
        state.votedFor = null;
        persistState();
        stopHeartbeat();
        resetElectionTimer();
    }
}

// ==============================================================================
// ELECTION LOGIC (Day 2-3)
// ==============================================================================

async function startElection() {
    state.role = "candidate";
    state.currentTerm += 1;
    state.votedFor = REPLICA_ID;
    persistState();
    let votesReceived = 1;

    log("ELECTION", `Starting election for term ${state.currentTerm}`);
    resetElectionTimer();

    const voteRequests = PEERS.map(async (peer) => {
        try {
            const lastLog = state.log[state.log.length - 1];
            const response = await axios.post(
                `${peer}/request-vote`,
                {
                    term: state.currentTerm,
                    candidateId: REPLICA_ID,
                    lastLogIndex: lastLog ? lastLog.index : -1,
                    lastLogTerm: lastLog ? lastLog.term : 0,
                },
                { timeout: 300 }
            );

            if (response.data.term > state.currentTerm) {
                stepDown(response.data.term);
                return false;
            }

            if (response.data.voteGranted) {
                log("ELECTION", `Vote granted from ${peer}`);
                return true;
            }
            return false;
        } catch (err) {
            log("ELECTION", `Peer ${peer} unreachable`);
            return false;
        }
    });

    const results = await Promise.all(voteRequests);
    votesReceived += results.filter(Boolean).length;

    log("ELECTION", `Votes received: ${votesReceived}/${PEERS.length + 1}`);

    if (votesReceived >= MAJORITY && state.role === "candidate") {
        becomeLeader();
    } else if (state.role === "candidate") {
        log("ELECTION", `Election lost or split vote - will retry`);
        state.role = "follower";
        state.votedFor = null;
        persistState();
    }
}

// ==============================================================================
// LEADER LOGIC (Day 3-4)
// ==============================================================================

function becomeLeader() {
    state.role = "leader";
    state.leaderId = REPLICA_ID;
    stopElectionTimer();

    leaderState.nextIndex = {};
    leaderState.matchIndex = {};
    for (const peer of PEERS) {
        leaderState.nextIndex[peer] = state.log.length;
        leaderState.matchIndex[peer] = -1;
    }

    log("LEADER", `*** BECAME LEADER for term ${state.currentTerm} ***`);
    sendHeartbeats();
    startHeartbeat();
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

function startHeartbeat() {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
        if (state.role !== "leader") {
            stopHeartbeat();
            return;
        }
        sendHeartbeats();
    }, HEARTBEAT_INTERVAL);
}

async function sendHeartbeats() {
    for (const peer of PEERS) {
        try {
            const response = await axios.post(
                `${peer}/heartbeat`,
                { term: state.currentTerm, leaderId: REPLICA_ID, leaderCommit: state.commitIndex },
                { timeout: 100 }
            );

            if (response.data.term > state.currentTerm) {
                stepDown(response.data.term);
                return;
            }

            if (response.data.needSync) {
                log("SYNC", `Follower ${peer} needs sync from index ${response.data.logLength}`);
                syncFollower(peer, response.data.logLength);
            }
        } catch (err) {}
    }
}

// ==============================================================================
// LOG REPLICATION (Day 4)
// ==============================================================================

async function replicateLogEntry(entryPayload, entryLabel) {
    if (state.role !== "leader") {
        return { success: false, reason: "not leader", leaderId: state.leaderId };
    }

    const newEntry = {
        term: state.currentTerm,
        index: state.log.length,
        ...entryPayload,
        committed: false,
    };
    state.log.push(newEntry);
    persistState();
    log("REPLICATION", `Appended ${entryLabel} to log at index ${newEntry.index}`);

    let acks = 1;

    const replicationPromises = PEERS.map(async (peer) => {
        try {
            const prevLogIndex = newEntry.index - 1;
            const prevLogTerm = prevLogIndex >= 0 ? state.log[prevLogIndex].term : 0;

            const response = await axios.post(
                `${peer}/append-entries`,
                {
                    term: state.currentTerm,
                    leaderId: REPLICA_ID,
                    entries: [newEntry],
                    prevLogIndex,
                    prevLogTerm,
                    leaderCommit: state.commitIndex,
                },
                { timeout: 300 }
            );

            if (response.data.term > state.currentTerm) {
                stepDown(response.data.term);
                return false;
            }

            if (response.data.success) {
                leaderState.nextIndex[peer] = newEntry.index + 1;
                leaderState.matchIndex[peer] = newEntry.index;
                log("REPLICATION", `Ack from ${peer}`);
                return true;
            } else if (response.data.needSync) {
                log("REPLICATION", `Follower ${peer} needs sync`);
                syncFollower(peer, response.data.logLength || 0);
                return false;
            }
            return false;
        } catch (err) {
            log("REPLICATION", `Follower ${peer} unreachable`);
            return false;
        }
    });

    const results = await Promise.all(replicationPromises);
    acks += results.filter(Boolean).length;

    log("REPLICATION", `Acks received: ${acks}/${PEERS.length + 1}`);

    if (acks >= MAJORITY) {
        if (state.log[newEntry.index]) {
            state.log[newEntry.index].committed = true;
        }
        state.commitIndex = newEntry.index;
        state.lastApplied = Math.max(state.lastApplied, state.commitIndex);
        persistState();
        log("COMMIT", `${entryLabel} COMMITTED at index ${newEntry.index}`);
        return { success: true, entry: newEntry };
    } else {
        log("COMMIT", `Not enough acks - entry NOT committed`);
        return { success: false, reason: "no majority" };
    }
}

async function replicateStroke(stroke) {
    return replicateLogEntry({ stroke }, "stroke");
}

async function replicateClear(clientId) {
    return replicateLogEntry(
        {
            stroke: {
                kind: "clear",
                source: clientId || "unknown",
                timestamp: Date.now(),
            },
        },
        "clear command"
    );
}

// ==============================================================================
// LOG SYNC (Day 5)
// ==============================================================================

async function syncFollower(peer, fromIndex) {
    if (state.role !== "leader") return;

    const entriesToSend = state.log.slice(fromIndex);
    if (entriesToSend.length === 0) return;

    log("SYNC", `Sending ${entriesToSend.length} entries to ${peer} from index ${fromIndex}`);

    try {
        const prevLogIndex = fromIndex - 1;
        const prevLogTerm = prevLogIndex >= 0 ? state.log[prevLogIndex].term : 0;

        const response = await axios.post(
            `${peer}/append-entries`,
            {
                term: state.currentTerm,
                leaderId: REPLICA_ID,
                entries: entriesToSend,
                prevLogIndex,
                prevLogTerm,
                leaderCommit: state.commitIndex,
            },
            { timeout: 1000 }
        );

        if (response.data.success) {
            leaderState.nextIndex[peer] = state.log.length;
            leaderState.matchIndex[peer] = state.log.length - 1;
            log("SYNC", `Follower ${peer} synced successfully`);
        }
    } catch (err) {
        log("SYNC", `Failed to sync follower ${peer}`);
    }
}

// ==============================================================================
// HTTP ENDPOINTS
// ==============================================================================

app.get("/health", (req, res) => {
    res.json({
        replicaId: REPLICA_ID,
        role: state.role,
        term: state.currentTerm,
        leader: state.leaderId,
        logLength: state.log.length,
        commitIndex: state.commitIndex,
        peers: PEERS,
    });
});

app.get("/log", (req, res) => {
    res.json({
        replicaId: REPLICA_ID,
        role: state.role,
        term: state.currentTerm,
        log: state.log,
        commitIndex: state.commitIndex,
    });
});

app.get("/committed", (req, res) => {
    const fromIndex = Math.max(0, parseInt(req.query.from, 10) || 0);
    const committed = state.log
        .filter((entry) => entry && entry.committed && Number.isInteger(entry.index) && entry.index >= fromIndex)
        .sort((a, b) => a.index - b.index);
    res.json({ entries: committed, commitIndex: state.commitIndex });
});

app.post("/stroke", async (req, res) => {
    const { stroke } = req.body;

    if (state.role !== "leader") {
        log("STROKE", `Not leader - redirecting to ${state.leaderId}`);
        return res.status(403).json({ success: false, reason: "not leader", leaderId: state.leaderId });
    }

    log("STROKE", `Received stroke from client`);
    const result = await replicateStroke(stroke);
    res.json(result);
});

app.post("/clear", async (req, res) => {
    const { clientId } = req.body || {};

    if (state.role !== "leader") {
        log("CLEAR", `Not leader - redirecting to ${state.leaderId}`);
        return res.status(403).json({ success: false, reason: "not leader", leaderId: state.leaderId });
    }

    log("CLEAR", `Received clear command from ${clientId || "unknown"}`);
    const result = await replicateClear(clientId);
    res.json(result);
});

app.post("/request-vote", (req, res) => {
    const { term, candidateId, lastLogIndex, lastLogTerm } = req.body;

    log("VOTE", `Vote request from ${candidateId} for term ${term}`);

    if (term < state.currentTerm) {
        log("VOTE", `Rejected: old term ${term} < ${state.currentTerm}`);
        return res.json({ voteGranted: false, term: state.currentTerm });
    }

    if (term > state.currentTerm) {
        stepDown(term);
    }

    const canVote = state.votedFor === null || state.votedFor === candidateId;

    const myLastLog = state.log[state.log.length - 1];
    const myLastIndex = myLastLog ? myLastLog.index : -1;
    const myLastTerm = myLastLog ? myLastLog.term : 0;

    const candidateLogOk = lastLogTerm > myLastTerm || (lastLogTerm === myLastTerm && lastLogIndex >= myLastIndex);

    if (canVote && candidateLogOk) {
        state.votedFor = candidateId;
        persistState();
        resetElectionTimer();
        log("VOTE", `Voted for ${candidateId} in term ${term}`);
        return res.json({ voteGranted: true, term: state.currentTerm });
    }

    log("VOTE", `Vote denied to ${candidateId}`);
    return res.json({ voteGranted: false, term: state.currentTerm });
});

app.post("/append-entries", (req, res) => {
    const { term, leaderId, entries, prevLogIndex, prevLogTerm, leaderCommit } = req.body;
    const incomingEntries = Array.isArray(entries) ? entries : [];
    let stateChanged = false;

    if (term < state.currentTerm) {
        log("APPEND", `Rejected: old term ${term}`);
        return res.json({ success: false, term: state.currentTerm });
    }

    if (term > state.currentTerm) {
        stepDown(term);
    }
    state.role = "follower";
    state.leaderId = leaderId;
    resetElectionTimer();

    if (prevLogIndex >= 0) {
        const prevEntry = state.log[prevLogIndex];
        if (!prevEntry || prevEntry.term !== prevLogTerm) {
            log("APPEND", `Log mismatch at index ${prevLogIndex}, need sync`);
            return res.json({ success: false, term: state.currentTerm, logLength: state.log.length, needSync: true });
        }
    }

    if (incomingEntries.length > 0) {
        let expectedIndex = prevLogIndex + 1;
        for (const entry of incomingEntries) {
            if (!entry || !Number.isInteger(entry.index) || !Number.isInteger(entry.term) || entry.index !== expectedIndex) {
                log("APPEND", `Rejected non-contiguous entries at expected index ${expectedIndex}`);
                return res.json({ success: false, term: state.currentTerm, logLength: state.log.length, needSync: true });
            }
            expectedIndex += 1;
        }

        for (const entry of incomingEntries) {
            if (state.log[entry.index] && state.log[entry.index].term !== entry.term) {
                state.log = state.log.slice(0, entry.index);
            }

            if (entry.index === state.log.length) {
                state.log.push(entry);
            } else {
                state.log[entry.index] = entry;
            }
        }
        stateChanged = true;
        log(
            "APPEND",
            `Appended ${incomingEntries.length} entries (${incomingEntries[0].index}-${incomingEntries[incomingEntries.length - 1].index})`
        );
    }

    if (Number.isInteger(leaderCommit) && leaderCommit > state.commitIndex) {
        const lastNewIndex = incomingEntries.length > 0 ? incomingEntries[incomingEntries.length - 1].index : state.log.length - 1;
        state.commitIndex = Math.min(leaderCommit, lastNewIndex);
        state.lastApplied = Math.max(state.lastApplied, state.commitIndex);
        for (let i = 0; i <= state.commitIndex; i++) {
            if (state.log[i]) state.log[i].committed = true;
        }
        stateChanged = true;
        log("COMMIT", `Commit index updated to ${state.commitIndex}`);
    }

    if (stateChanged) {
        persistState();
    }

    return res.json({ success: true, term: state.currentTerm });
});

app.post("/heartbeat", (req, res) => {
    const { term, leaderId, leaderCommit } = req.body;

    if (term < state.currentTerm) {
        return res.json({ success: false, term: state.currentTerm });
    }

    if (term > state.currentTerm) {
        stepDown(term);
    }

    state.role = "follower";
    state.leaderId = leaderId;
    resetElectionTimer();

    if (Number.isInteger(leaderCommit) && leaderCommit > state.commitIndex) {
        state.commitIndex = Math.min(leaderCommit, state.log.length - 1);
        state.lastApplied = Math.max(state.lastApplied, state.commitIndex);
        for (let i = 0; i <= state.commitIndex; i++) {
            if (state.log[i]) state.log[i].committed = true;
        }
        persistState();
    }

    const needSync = leaderCommit > state.log.length - 1;
    return res.json({ success: true, term: state.currentTerm, needSync, logLength: state.log.length });
});

app.post("/sync-log", (req, res) => {
    const { fromIndex } = req.body;

    if (state.role !== "leader") {
        return res.json({ success: false, reason: "not leader", leaderId: state.leaderId });
    }

    const entries = state.log.slice(fromIndex || 0);
    log("SYNC", `Sync request: sending ${entries.length} entries from index ${fromIndex || 0}`);
    return res.json({ success: true, entries, commitIndex: state.commitIndex, term: state.currentTerm });
});

app.get("/sync-log", (req, res) => {
    const fromIndex = parseInt(req.query.from) || 0;
    const entries = state.log.slice(fromIndex);
    return res.json({ entries, commitIndex: state.commitIndex, term: state.currentTerm, role: state.role });
});

// ==============================================================================
// STARTUP
// ==============================================================================

loadStateFromDisk();

app.listen(PORT, () => {
    log("STARTUP", `Replica ${REPLICA_ID} started on port ${PORT}`);
    log("STARTUP", `Peers: ${PEERS.join(", ")}`);
    log("STARTUP", `Election timeout: ${ELECTION_TIMEOUT_MIN}-${ELECTION_TIMEOUT_MAX}ms, Heartbeat: ${HEARTBEAT_INTERVAL}ms`);
    resetElectionTimer();
});
