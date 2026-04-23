# Architecture Document - MiniRAFT Distributed Drawing Board

## 1. System Overview

The system is a fault-tolerant collaborative whiteboard that enables real-time drawing across multiple browser clients. It uses a **Mini-RAFT consensus protocol** to ensure all 3 backend replica nodes maintain identical stroke logs, even during node failures and restarts.

### 1.1 Cluster Diagram

```
                    ┌──────────────────────────────┐
                    │        Browser Clients       │
                    │  (HTML5 Canvas + WebSocket)  │
                    └──────────────┬───────────────┘
                                   │ ws://host:8080/ws
                    ┌──────────────▼────────────────┐
                    │     Nginx Frontend (:8080)    │
                    │  Static HTML │ WS proxy │ API │
                    └──────┬───────┴────┬───────────┘
                           │            │
                      /ws  │    /api/*  │
                           │            │
                    ┌──────▼────────────▼───────────┐
                    │    Gateway Service (:3000)    │
                    │  WebSocket Hub │ Leader Route │
                    │  Stroke Batcher│ Dashboard API│
                    └──────┬────────────────────────┘
                           │
              POST /strokes (to leader)
              POST /commit-batch (from leader)
              POST /notify-leader (on election)
                           │
            ┌──────────────┼──────────────┐
            │              │              │
     ┌──────▼─────┐  ┌─────▼──────┐  ┌─────▼──────┐
     │ Replica 1   │ │ Replica 2   │ │ Replica 3   │
     │ :4001       │ │ :4002       │ │ :4003       │
     │             │ │             │ │             │
     │ Role: L/F/C │ │ Role: L/F/C │ │ Role: L/F/C │
     │ Term: N     │ │ Term: N     │ │ Term: N     │
     │ Log: [...]  │ │ Log: [...]  │ │ Log: [...]  │
     └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
            │               │               │
            └───────────────┴───────────────┘
               AppendEntries / RequestVote
               (HTTP POST between replicas)
```

### 1.2 Service Responsibilities

| Service | Technology | Role |
|---------|-----------|------|
| **Frontend** | Nginx Alpine | Serves `index.html` (whiteboard) and `dashboard.html` (monitoring). Proxies WebSocket (`/ws`) and REST (`/api/*`) to the Gateway. |
| **Gateway** | Node.js + Express + ws | Manages browser WebSocket connections. Batches incoming strokes and forwards them to the RAFT leader. Broadcasts committed strokes to all clients. Provides cluster monitoring API. |
| **Replica ×3** | Node.js + Express + axios | Implements Mini-RAFT consensus. Maintains append-only stroke log. Participates in leader election, log replication, and majority commit. |

---

## 2. Mini-RAFT Protocol Design

### 2.1 State Transition Diagram

```
                  ┌─────────────────────────────────────────┐
                  │                                         │
                  │    ┌──────────┐                         │
                  │    │ FOLLOWER │ ◄───────────────────────┤
                  │    └────┬─────┘                         │
                  │         │                               │
                  │  election timeout                       │
                  │  (1500-3000ms, no heartbeat received)   │
                  │         │                               │
                  │    ┌────▼──────┐                        │
                  │    │ CANDIDATE │                        │
                  │    └────┬──────┘                        │
                  │         │                               │
                  │    ┌────┴────┐                          │
                  │    │         │                          │
                  │  majority  split vote                   │
                  │  votes      (retry with backoff)        │
                  │    │         │                          │
                  │    │    back to FOLLOWER ───────────────┤
                  │    │                                    │
                  │  ┌─▼──────┐                             │
                  │  │ LEADER │                             │
                  │  └────────┘                             │
                  │       │                                 │
                  │  discovers higher term ─────────────────┘
                  │
                  └──────────────────────────────────────────
```

### 2.2 Election Rules

1. Each node starts as a **Follower** with a random election timeout (1500-3000ms).
2. Timeout is staggered by replica ID: `base + (ID % 3) × 100ms + random(0, 1500ms)`.
3. If a follower does not receive a heartbeat (AppendEntries) before its timer expires, it becomes a **Candidate**.
4. The candidate increments its `term`, votes for itself, and sends `RequestVote` RPCs to all peers.
5. A node grants a vote if: (a) the candidate's term ≥ its own, (b) it hasn't voted in this term, and (c) the candidate's log is at least as up-to-date.
6. If the candidate receives votes from a **majority (≥2 of 3)**, it immediately becomes **Leader** (early promotion - doesn't wait for all responses).
7. On becoming leader, it immediately sends an AppendEntries heartbeat (awaited) to suppress other elections.
8. If a split vote occurs, nodes retry with exponential random backoff.

### 2.3 Log Replication Rules

```
  Client Stroke
       │
       ▼
  Gateway batches stroke(s)
       │
       ▼  POST /strokes
  Leader appends to raftLog[]
       │
       ├──────────────────────┐
       ▼ POST /append-entries  ▼ POST /append-entries
   Follower 1              Follower 2
       │                       │
       └────── ACK ────────────┘
                │
       majority reached (2/3)
                │
       Leader advances commitIndex
                │
       Leader POST /commit-batch → Gateway
                │
       Gateway broadcasts to all WebSocket clients
```

**Safety Rules:**
- Committed entries are never overwritten
- Higher term always wins (leader steps down if it sees a higher term)
- Entries are only committed if they belong to the current term
- A vote is granted at most once per term

### 2.4 Catch-Up Protocol (Restarted Nodes)

1. Restarted node starts as Follower with an empty log
2. On first `AppendEntries` from leader, `prevLogIndex` check fails
3. Follower returns `{success: false, conflict_index: currentLogLength}`
4. Follower calls `POST /sync-log` on the leader with `from_index`
5. Leader responds with all committed entries from that index onward
6. Follower appends missing entries, updates `commitIndex`, and resumes normal replication

---

## 3. API Specification

### 3.1 Replica RPC Endpoints

#### `POST /request-vote`
**Request Body:**
```json
{
  "term": 5,
  "candidate_id": "replica1",
  "last_log_index": 42,
  "last_log_term": 4
}
```
**Response:**
```json
{
  "term": 5,
  "vote_granted": true
}
```

#### `POST /append-entries`
**Request Body:**
```json
{
  "term": 5,
  "leader_id": "replica1",
  "prev_log_index": 41,
  "prev_log_term": 4,
  "entries": [{"term": 5, "data": {"x0":10,"y0":20,"x1":30,"y1":40,"color":"#000","width":3,"tool":"draw"}}],
  "leader_commit": 40
}
```
**Response (success):**
```json
{"term": 5, "success": true}
```
**Response (conflict):**
```json
{"term": 5, "success": false, "conflict_index": 38}
```

#### `POST /heartbeat`
**Request:** `{"term": 5, "leader_id": "replica1", "leader_commit": 40}`
**Response:** `{"term": 5, "success": true}`

#### `POST /sync-log`
**Request:** `{"from_index": 0}`
**Response:**
```json
{
  "term": 5,
  "leader_id": "replica1",
  "from_index": 0,
  "commit_index": 40,
  "entries": [{"term": 1, "data": {...}}, ...]
}
```

#### `POST /stroke` and `POST /strokes`
Leader-only. Accepts single or batch of strokes from gateway. Returns `307` with `leader_id` if not the current leader.

#### `POST /clear`
Leader-only. Appends a replicated clear marker `{type: "clear"}` to the log.

#### `GET /status`
```json
{
  "id": "replica1",
  "role": "leader",
  "term": 5,
  "leader_id": "replica1",
  "log_length": 43,
  "commit_index": 40,
  "last_applied": 40,
  "peers": ["http://replica2:4002", "http://replica3:4003"]
}
```

#### `GET /log`
Returns committed strokes after the last clear marker (for canvas replay on new client connect).

### 3.2 Gateway Endpoints

| Endpoint | Description |
|----------|-------------|
| `WS /ws` | Browser WebSocket. Receives `{type:"stroke", stroke:{...}}` or `{type:"strokes", strokes:[...]}` or `{type:"clear"}`. Sends back `{type:"stroke"}`, `{type:"strokes"}`, `{type:"clear"}`, `{type:"full_log"}`, `{type:"leader_change"}`. |
| `POST /commit-batch` | Leader pushes committed entries. Gateway broadcasts to all clients. |
| `POST /notify-leader` | Newly elected leader registers `{leader_id, leader_url, term}`. |
| `GET /status` | `{current_leader, connected_clients, pending_strokes, replicas, term}` |
| `GET /dashboard-data` | Aggregated cluster data for monitoring dashboard. |

---

## 4. Failure Handling Design

### 4.1 Failure Scenarios

| Scenario | System Behavior |
|----------|----------------|
| **Leader crash** | Followers' election timers expire (1.5-3s). One becomes candidate, wins election. Gateway discovers new leader via `/notify-leader` or polling `/status`. Clients are never disconnected. |
| **Follower crash** | Leader continues with remaining follower. Majority (2/3) still achievable. Restarted follower catches up via `/sync-log`. |
| **Gateway restart** | All WebSocket clients reconnect (auto-reconnect with 2s delay). Gateway re-discovers leader and replays committed log to new connections. |
| **Network partition (2 nodes isolated)** | The partition with the majority (2 nodes) elects a leader and continues. The isolated node cannot win election (no majority). On partition heal, it catches up. |
| **Hot reload (file edit)** | `node --watch` restarts the process. Container stays running (`restart: unless-stopped`). RAFT election happens automatically. System stays live. |
| **All nodes restart simultaneously** | All start as followers, one wins the first election. Log is lost (in-memory). Canvas starts fresh. |
| **Rapid successive failures** | Exponential backoff on split votes prevents election storms. System stabilizes within a few terms. |

### 4.2 Leader Failover Sequence

```
1. Replica1 (LEADER) crashes
2. Replica2: election timer expires (1.5-3s)
3. Replica2: term++ → becomes CANDIDATE
4. Replica2: sends RequestVote to Replica3
5. Replica3: grants vote (candidate log is up-to-date)
6. Replica2: has 2 votes (majority) → becomes LEADER
7. Replica2: sends immediate AppendEntries to Replica3 (heartbeat)
8. Replica2: POST /notify-leader to Gateway
9. Gateway: updates leader URL, broadcasts leader_change to clients
10. Clients: see new leader in session panel
```

### 4.3 Sync-Log Catch-Up Sequence

```
1. Replica1 restarts (empty log)
2. Leader sends AppendEntries(prevLogIndex=42, ...)
3. Replica1: prevLogIndex 42 > log.length 0 → FAIL
4. Replica1: calls POST /sync-log to leader with from_index=0
5. Leader: responds with all committed entries [0..42]
6. Replica1: appends all entries, updates commitIndex=42
7. Replica1: now in sync, normal replication resumes
```

---

## 5. Docker & Deployment

### 5.1 Container Architecture

| Container | Image Base | Volumes | Env Vars |
|-----------|-----------|---------|----------|
| frontend | nginx:alpine | - | - |
| gateway | node:20-alpine | `./gateway:/app` | `REPLICA_URLS`, `GATEWAY_PORT` |
| replica1 | node:20-alpine | `./replica1:/app` | `REPLICA_ID=replica1`, `PORT=4001`, `PEERS`, `GATEWAY_URL` |
| replica2 | node:20-alpine | `./replica2:/app` | `REPLICA_ID=replica2`, `PORT=4002`, `PEERS`, `GATEWAY_URL` |
| replica3 | node:20-alpine | `./replica3:/app` | `REPLICA_ID=replica3`, `PORT=4003`, `PEERS`, `GATEWAY_URL` |

### 5.2 Startup Ordering

```
replica1 ──┐
replica2 ──┼── (condition: service_healthy) ──► gateway ── (condition: service_healthy) ──► frontend
replica3 ──┘
```

### 5.3 Hot Reload

Each replica container uses `node --watch server.js` which automatically restarts the Node.js process when the bind-mounted `server.js` file changes. The container itself stays running, and the RAFT protocol handles the temporary unavailability gracefully.

---

## 6. Integration Log

### 6.1 Initial Election (3 nodes)

```
replica2  | Replica replica2 started on port 4002, peers=http://replica1:4001,http://replica3:4003
replica2  | ⚡ ELECTION term=1
replica2  | Vote granted by http://replica1:4001 term=1 (2/2)
replica2  | ★ LEADER term=1
replica2  | Notified gateway of leadership
replica1  | → FOLLOWER term=1 leader=null
replica1  | Voted for replica2 term=1
replica3  | → FOLLOWER term=1 leader=null
replica3  | Voted for replica2 term=1
```

### 6.2 Leader Failover (replica2 killed)

```
# docker-compose stop replica2
replica1  | → FOLLOWER term=2 leader=null
replica1  | ⚡ ELECTION term=3
replica1  | Vote granted by http://replica3:4003 term=3 (2/2)
replica1  | ★ LEADER term=3
replica1  | Notified gateway of leadership
replica3  | Voted for replica1 term=3
```

### 6.3 Node Rejoin & Sync (replica2 restarted)

```
# docker-compose start replica2
replica2  | Replica replica2 started on port 4002
replica2  | → FOLLOWER term=3 leader=replica1
replica2  | Sync catch-up: 41 entries from replica1
replica2  | Pushed 41 commits (up to index=40)
```

### 6.4 Stroke Commit Flow

```
gateway   | Client connected total=2
replica1  | Appended batch size=3 range=0..2
replica1  | Committed index=2
replica1  | Pushed 3 commits (up to index=2)
gateway   | Committed batch count=3 upto=2 deduped=0
```

---

## 7. Cloud Computing Concepts Demonstrated

| Concept | Implementation |
|---------|---------------|
| **Consensus Protocol** | Mini-RAFT - leader election via term-based voting, log replication via AppendEntries, majority commit (2 of 3) |
| **Fault Tolerance** | Any single node can crash. System auto-recovers via re-election. Restarted nodes catch up via sync-log. |
| **Zero-Downtime Deployments** | Bind-mounted source + `node --watch` = file edit triggers graceful restart. RAFT handles the temporary gap. |
| **State Replication** | Append-only stroke log replicated across all 3 nodes. Commit only after majority confirmation. |
| **Service Discovery** | Gateway polls `/status` and receives `/notify-leader` callbacks. No external service registry needed. |
| **Real-Time Collaboration** | WebSocket broadcast ensures sub-second propagation of committed strokes to all connected browsers. |
| **Containerisation** | 5-service docker-compose stack with health checks, startup ordering, shared network, and bind mounts. |
| **Observability** | Console logs for elections, votes, commits, syncs. Dashboard UI shows live cluster stats, metrics, and event log. |
