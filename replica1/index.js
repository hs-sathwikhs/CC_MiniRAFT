const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

// ── Node Identity ──────────────────────────────────────────
const REPLICA_ID = process.env.REPLICA_ID || "1";
const PORT = process.env.PORT || 5001;

const OTHER_REPLICAS = {
    "1": ["http://localhost:5002", "http://localhost:5003"],
    "2": ["http://localhost:5001", "http://localhost:5003"],
    "3": ["http://localhost:5001", "http://localhost:5002"],
};

const PEERS = OTHER_REPLICAS[REPLICA_ID];

// ── RAFT State ─────────────────────────────────────────────
let state = {
    role: "follower",
    currentTerm: 0,
    votedFor: null,
    log: [],          // each entry: { term, index, stroke }
    commitIndex: -1,
    leaderId: null,
};

// ── Election Timer ─────────────────────────────────────────
let electionTimer = null;

function getRandomTimeout() {
    return Math.floor(Math.random() * 300) + 500;
}

function resetElectionTimer() {
    if (electionTimer) clearTimeout(electionTimer);
    electionTimer = setTimeout(() => {
        if (state.role !== "leader") {
            console.log(`[Replica ${REPLICA_ID}] Timeout! Starting election...`);
            startElection();
        }
    }, getRandomTimeout());
}

// ── Election ───────────────────────────────────────────────
async function startElection() {
    state.role = "candidate";
    state.currentTerm += 1;
    state.votedFor = REPLICA_ID;
    let votesReceived = 1;

    console.log(`[Replica ${REPLICA_ID}] CANDIDATE for term ${state.currentTerm}`);

    // Reset timer in case election fails (split vote)
    resetElectionTimer();

    for (const peer of PEERS) {
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
                console.log(`[Replica ${REPLICA_ID}] Higher term, stepping down`);
                state.role = "follower";
                state.currentTerm = response.data.term;
                state.votedFor = null;
                resetElectionTimer();
                return;
            }

            if (response.data.voteGranted) {
                votesReceived += 1;
                console.log(`[Replica ${REPLICA_ID}] Vote from ${peer} | Total: ${votesReceived}`);
            }
        } catch (err) {
            console.log(`[Replica ${REPLICA_ID}] Peer ${peer} unreachable for vote`);
        }
    }

    if (votesReceived >= 2 && state.role === "candidate") {
        becomeLeader();
    } else {
        console.log(`[Replica ${REPLICA_ID}] Lost election, back to follower`);
        state.role = "follower";
        state.votedFor = null;
    }
}

// ── Leader ─────────────────────────────────────────────────
function becomeLeader() {
    state.role = "leader";
    state.leaderId = REPLICA_ID;
    if (electionTimer) clearTimeout(electionTimer);
    console.log(`[Replica ${REPLICA_ID}] *** LEADER for term ${state.currentTerm} ***`);
    startHeartbeat();
}

// ── Heartbeat Sender ───────────────────────────────────────
let heartbeatInterval = null;

function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    heartbeatInterval = setInterval(async () => {
        if (state.role !== "leader") {
            clearInterval(heartbeatInterval);
            return;
        }
        for (const peer of PEERS) {
            try {
                await axios.post(
                    `${peer}/heartbeat`,
                    { term: state.currentTerm, leaderId: REPLICA_ID },
                    { timeout: 100 }
                );
            } catch (_) {}
        }
    }, 150);
}

// ── Log Replication ────────────────────────────────────────
// Called when gateway sends a stroke to the leader
async function replicateStroke(stroke) {
    if (state.role !== "leader") {
        return { success: false, reason: "not leader" };
    }

    // Step 1: Append to own log first
    const newEntry = {
        term: state.currentTerm,
        index: state.log.length,
        stroke: stroke,
        committed: false,
    };
    state.log.push(newEntry);
    console.log(`[Replica ${REPLICA_ID}] Appended stroke to log at index ${newEntry.index}`);

    // Step 2: Send to all followers
    let acks = 1; // leader counts as 1

    for (const peer of PEERS) {
        try {
            const response = await axios.post(
                `${peer}/append-entries`,
                {
                    term: state.currentTerm,
                    leaderId: REPLICA_ID,
                    entry: newEntry,
                    prevLogIndex: newEntry.index - 1,
                    prevLogTerm: newEntry.index > 0 ? state.log[newEntry.index - 1].term : 0,
                    leaderCommit: state.commitIndex,
                },
                { timeout: 300 }
            );

            if (response.data.success) {
                acks += 1;
                console.log(`[Replica ${REPLICA_ID}] Ack from ${peer} | Total acks: ${acks}`);
            }
        } catch (err) {
            console.log(`[Replica ${REPLICA_ID}] Follower ${peer} unreachable during replication`);
        }
    }

    // Step 3: Commit if majority acknowledged
    if (acks >= 2) {
        state.log[newEntry.index].committed = true;
        state.commitIndex = newEntry.index;
        console.log(`[Replica ${REPLICA_ID}] ✅ Stroke COMMITTED at index ${newEntry.index}`);
        return { success: true, entry: newEntry };
    } else {
        console.log(`[Replica ${REPLICA_ID}] ❌ Not enough acks, stroke not committed`);
        return { success: false, reason: "no majority" };
    }
}

// ── Routes ─────────────────────────────────────────────────

app.get("/health", (req, res) => {
    res.json({
        replicaId: REPLICA_ID,
        role: state.role,
        term: state.currentTerm,
        leader: state.leaderId,
        logLength: state.log.length,
        commitIndex: state.commitIndex,
    });
});

// Gateway sends stroke to leader via this route
app.post("/stroke", async (req, res) => {
    const { stroke } = req.body;

    if (state.role !== "leader") {
        return res.status(403).json({
            success: false,
            reason: "not leader",
            leaderId: state.leaderId,
        });
    }

    const result = await replicateStroke(stroke);
    res.json(result);
});

// Follower receives vote request from candidate
app.post("/request-vote", (req, res) => {
    const { term, candidateId, lastLogIndex, lastLogTerm } = req.body;

    if (term < state.currentTerm) {
        return res.json({ voteGranted: false, term: state.currentTerm });
    }

    if (term > state.currentTerm) {
        state.currentTerm = term;
        state.role = "follower";
        state.votedFor = null;
    }

    const canVote =
        state.votedFor === null || state.votedFor === candidateId;

    // Log completeness check
    // Only vote for candidate if their log is at least as complete as ours
    const myLastLog = state.log[state.log.length - 1];
    const myLastIndex = myLastLog ? myLastLog.index : -1;
    const myLastTerm = myLastLog ? myLastLog.term : 0;

    const candidateLogOk =
        lastLogTerm > myLastTerm ||
        (lastLogTerm === myLastTerm && lastLogIndex >= myLastIndex);

    if (canVote && candidateLogOk) {
        state.votedFor = candidateId;
        console.log(`[Replica ${REPLICA_ID}] Voted for ${candidateId} in term ${term}`);
        resetElectionTimer();
        return res.json({ voteGranted: true, term: state.currentTerm });
    }

    return res.json({ voteGranted: false, term: state.currentTerm });
});

// Follower receives stroke entry from leader
app.post("/append-entries", (req, res) => {
    const { term, leaderId, entry, prevLogIndex, leaderCommit } = req.body;

    // Reject old leaders
    if (term < state.currentTerm) {
        return res.json({ success: false, term: state.currentTerm });
    }

    // Valid leader, reset our timer
    state.role = "follower";
    state.currentTerm = term;
    state.leaderId = leaderId;
    state.votedFor = null;
    resetElectionTimer();

    // Check log consistency
    // If prevLogIndex exists, we must have that entry
    if (prevLogIndex >= 0 && !state.log[prevLogIndex]) {
        console.log(`[Replica ${REPLICA_ID}] Log mismatch at index ${prevLogIndex}, need sync`);
        return res.json({
            success: false,
            term: state.currentTerm,
            logLength: state.log.length,
            needSync: true,
        });
    }

    // Append the new entry
    state.log[entry.index] = entry;
    console.log(`[Replica ${REPLICA_ID}] Appended entry at index ${entry.index}`);

    // Update commit index if leader says so
    if (leaderCommit > state.commitIndex) {
        state.commitIndex = Math.min(leaderCommit, entry.index);
        console.log(`[Replica ${REPLICA_ID}] Commit index updated to ${state.commitIndex}`);
    }

    return res.json({ success: true, term: state.currentTerm });
});

// Leader sends heartbeat
app.post("/heartbeat", (req, res) => {
    const { term, leaderId } = req.body;

    if (term < state.currentTerm) {
        return res.json({ success: false, term: state.currentTerm });
    }

    state.role = "follower";
    state.currentTerm = term;
    state.leaderId = leaderId;
    state.votedFor = null;
    resetElectionTimer();

    return res.json({ success: true, term: state.currentTerm });
});

// Placeholder — Day 5
app.post("/sync-log", (req, res) => {
    res.json({ entries: [] });
});

// ── Start ──────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[Replica ${REPLICA_ID}] Started on port ${PORT}`);
    resetElectionTimer();
});