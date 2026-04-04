const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

// ── Node Identity ──────────────────────────────────────────
const REPLICA_ID = process.env.REPLICA_ID || "3";
const PORT = process.env.PORT || 5003;

// These will be docker container names later (Sudarshan's job)
// For now we use localhost for local testing
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
    log: [],
    commitIndex: -1,
    leaderId: null,
};

// ── Election Timer ─────────────────────────────────────────
let electionTimer = null;

function getRandomTimeout() {
    // Random between 500ms and 800ms as per RAFT spec
    return Math.floor(Math.random() * 300) + 500;
}

function resetElectionTimer() {
    // Clear existing timer and start fresh
    if (electionTimer) clearTimeout(electionTimer);

    electionTimer = setTimeout(() => {
        if (state.role !== "leader") {
            console.log(`[Replica ${REPLICA_ID}] Heartbeat timeout! Starting election...`);
            startElection();
        }
    }, getRandomTimeout());
}

// ── Election Logic ─────────────────────────────────────────
async function startElection() {
    // Step 1: Become candidate
    state.role = "candidate";
    state.currentTerm += 1;
    state.votedFor = REPLICA_ID; // vote for yourself
    let votesReceived = 1;        // counting your own vote

    console.log(`[Replica ${REPLICA_ID}] became CANDIDATE for term ${state.currentTerm}`);

    // Step 2: Ask each peer for their vote
    for (const peer of PEERS) {
        try {
            const response = await axios.post(
                `${peer}/request-vote`,
                {
                    term: state.currentTerm,
                    candidateId: REPLICA_ID,
                },
                { timeout: 300 }
            );

            if (response.data.voteGranted) {
                votesReceived += 1;
                console.log(`[Replica ${REPLICA_ID}] Got vote from ${peer} | Total: ${votesReceived}`);
            }

            // If peer has higher term, step down immediately
            if (response.data.term > state.currentTerm) {
                console.log(`[Replica ${REPLICA_ID}] Higher term found, stepping down to follower`);
                state.role = "follower";
                state.currentTerm = response.data.term;
                state.votedFor = null;
                resetElectionTimer();
                return;
            }
        } catch (err) {
            // Peer is down or unreachable, skip it
            console.log(`[Replica ${REPLICA_ID}] Could not reach ${peer} for vote`);
        }
    }

    // Step 3: Check if we won (majority = at least 2 out of 3)
    if (votesReceived >= 2 && state.role === "candidate") {
        becomeLeader();
    } else {
        // Lost election, go back to follower and wait
        console.log(`[Replica ${REPLICA_ID}] Lost election, back to follower`);
        state.role = "follower";
        state.votedFor = null;
        resetElectionTimer();
    }
}

// ── Become Leader ──────────────────────────────────────────
function becomeLeader() {
    state.role = "leader";
    state.leaderId = REPLICA_ID;
    console.log(`[Replica ${REPLICA_ID}] *** BECAME LEADER for term ${state.currentTerm} ***`);

    // Start sending heartbeats to followers every 150ms
    startHeartbeat();
}

// ── Heartbeat Sender (Leader only) ────────────────────────
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
                    {
                        term: state.currentTerm,
                        leaderId: REPLICA_ID,
                    },
                    { timeout: 100 }
                );
            } catch (err) {
                // Peer is down, ignore for now
            }
        }
    }, 150);
}

// ── Endpoints ──────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
    res.json({
        replicaId: REPLICA_ID,
        role: state.role,
        term: state.currentTerm,
        leader: state.leaderId,
        logLength: state.log.length,
    });
});

// Another node is asking for our vote
app.post("/request-vote", (req, res) => {
    const { term, candidateId } = req.body;

    // Candidate has old term, reject
    if (term < state.currentTerm) {
        return res.json({ voteGranted: false, term: state.currentTerm });
    }

    // If we see a higher term, update ours and reset
    if (term > state.currentTerm) {
        state.currentTerm = term;
        state.role = "follower";
        state.votedFor = null;
    }

    // Grant vote if we haven't voted yet this term
    const canVote = state.votedFor === null || state.votedFor === candidateId;

    if (canVote) {
        state.votedFor = candidateId;
        console.log(`[Replica ${REPLICA_ID}] Voted for ${candidateId} in term ${term}`);
        resetElectionTimer();
        return res.json({ voteGranted: true, term: state.currentTerm });
    }

    return res.json({ voteGranted: false, term: state.currentTerm });
});

// Leader is sending a heartbeat
app.post("/heartbeat", (req, res) => {
    const { term, leaderId } = req.body;

    if (term < state.currentTerm) {
        return res.json({ success: false, term: state.currentTerm });
    }

    // Valid heartbeat — reset our timer and acknowledge leader
    state.role = "follower";
    state.currentTerm = term;
    state.leaderId = leaderId;
    state.votedFor = null;
    resetElectionTimer();

    console.log(`[Replica ${REPLICA_ID}] Heartbeat from leader ${leaderId} | term ${term}`);
    return res.json({ success: true, term: state.currentTerm });
});

// Placeholder — Day 4
app.post("/append-entries", (req, res) => {
    res.json({ success: false, term: state.currentTerm });
});

// Placeholder — Day 5
app.post("/sync-log", (req, res) => {
    res.json({ entries: [] });
});

// ── Start ──────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[Replica ${REPLICA_ID}] Started on port ${PORT} as FOLLOWER`);
    // Start election timer immediately on boot
    resetElectionTimer();
});