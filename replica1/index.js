const express = require("express");
const app = express();
app.use(express.json());

// ── Node Identity ──────────────────────────────────────────
const REPLICA_ID = process.env.REPLICA_ID || "1";
const PORT = process.env.PORT || 5001;

// Addresses of all 3 replicas so they can talk to each other
const ALL_REPLICAS = [
    "http://localhost:5001",
    "http://localhost:5002",
    "http://localhost:5003",
];

// ── RAFT State ─────────────────────────────────────────────
let state = {
    role: "follower",        // "follower" | "candidate" | "leader"
    currentTerm: 0,          // election term number
    votedFor: null,          // which node we voted for this term
    log: [],                 // array of committed stroke entries
    commitIndex: -1,         // index of last committed entry
    leaderId: null,          // who is the current leader
};

// ── Health Check ───────────────────────────────────────────
app.get("/health", (req, res) => {
    res.json({
        replicaId: REPLICA_ID,
        role: state.role,
        term: state.currentTerm,
        leader: state.leaderId,
        logLength: state.log.length,
    });
});

// ── Placeholder: Request Vote ──────────────────────────────
app.post("/request-vote", (req, res) => {
    // Day 3 - Satwik will implement this
    res.json({ voteGranted: false, term: state.currentTerm });
});

// ── Placeholder: Append Entries ────────────────────────────
app.post("/append-entries", (req, res) => {
    // Day 4 - Satwik will implement this
    res.json({ success: false, term: state.currentTerm });
});

// ── Placeholder: Heartbeat ─────────────────────────────────
app.post("/heartbeat", (req, res) => {
    // Day 5 - Satwik will implement this
    res.json({ success: true, term: state.currentTerm });
});

// ── Placeholder: Sync Log ──────────────────────────────────
app.post("/sync-log", (req, res) => {
    // Day 5 - Satwik will implement this
    res.json({ entries: [] });
});

// ── Start Server ───────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[Replica ${REPLICA_ID}] Started on port ${PORT}`);
    console.log(`[Replica ${REPLICA_ID}] Role: ${state.role} | Term: ${state.currentTerm}`);
});