# Mini-RAFT Gateway

**Author**: Sathwik HS  
**Component**: WebSocket Gateway for RAFT-based Collaborative Drawing Board

## Overview

The Gateway is the traffic controller for the entire Mini-RAFT system. It:
- Accepts WebSocket connections from multiple browser clients
- Routes drawing strokes to the current RAFT leader replica
- Broadcasts committed strokes back to all connected clients
- Handles leader failovers transparently without disconnecting clients

## Development Progress

### ✅ Day 1: WebSocket Foundation (COMPLETED)
- [x] Created `/gateway` folder structure
- [x] Set up `package.json` with dependencies (express, ws, axios)
- [x] Built WebSocket server accepting multiple connections
- [x] Implemented connection/disconnection handling
- [x] Created test UI for manual testing
- [x] Added logging for all events
- [x] **Deliverable**: Gateway accepts WebSocket connections and echoes messages ✓

### ✅ Day 2: Leader Discovery & Routing (COMPLETED)
- [x] Implemented `fetchReplicaStatus()` - poll individual replica health
- [x] Implemented `discoverLeader()` - find current leader from all replicas
- [x] Implemented `ensureLeaderUrl()` - cached leader with auto-discovery
- [x] Implemented `forwardStrokeToLeader()` - route strokes with retry logic
- [x] Updated WebSocket handler to forward strokes instead of echo
- [x] Added `/discover-leader` endpoint for manual trigger
- [x] Created enhanced test UI (`/test` route)
- [x] Added comprehensive error handling and exponential backoff
- [x] Added `safeSend()` helper to prevent WebSocket crashes
- [x] Fixed exponential backoff (was linear)
- [x] **Deliverable**: Strokes forwarded to leader with automatic discovery ✓

## ⚠️ Known Issues & Integration Dependencies

### 🔴 Missing Replica Endpoint (Blocking Full Day 2 Testing)

**Issue**: Gateway forwards strokes to `POST /client-stroke` endpoint, but replicas don't expose this endpoint yet.

**Impact**: 
- Leader discovery works ✅
- Stroke forwarding will fail with HTTP 404 ❌
- Cannot test end-to-end flow until replica endpoint exists

**Owner**: Satwik Bankapur (replica implementation)

**Scheduled Fix**: Day 4 in Satwik B's schedule

**Required Endpoint**:
```javascript
// Replicas need to implement:
app.post("/client-stroke", (req, res) => {
    // Accept stroke from gateway
    // Append to RAFT log
    // Replicate to followers
    // Return success/failure
    res.json({ ok: true, /* ... */ });
});
```

**Workaround**: Gateway code is correct and will work once endpoint is added. Currently documented as known limitation.

**Tracking**: GitHub issue [to be created]

### Other Dependencies

- Day 3 (Broadcasting) depends on leader calling gateway's `/replica-commit` endpoint
- Day 4 (Failover) depends on full RAFT election working
- Full system testing requires all components integrated

### 🔜 Day 3: Broadcasting Committed Entries (PENDING)
- [ ] Implement `POST /replica-commit` endpoint
- [ ] Cache committed entries with deduplication
- [ ] Broadcast to all WebSocket clients
- [ ] Real-time synchronization across tabs

### 🔜 Day 4: Failover & Re-routing (PENDING)
- [ ] Periodic leader health checks
- [ ] Automatic rediscovery on failure
- [ ] Request queueing during elections
- [ ] Seamless failover demonstration

### 🔜 Day 5: Dashboard & Monitoring (PENDING)
- [ ] Create `dashboard.html`
- [ ] Cluster status visualization
- [ ] Statistics endpoints
- [ ] Real-time monitoring UI

### 🔜 Day 6: Polish & Edge Cases (PENDING)
- [ ] Comprehensive error handling
- [ ] Edge case coverage
- [ ] Code documentation
- [ ] Integration testing

## How to Run

### Prerequisites
- Node.js 18+ installed
- npm or yarn package manager
- Replica servers running on ports 5001, 5002, 5003

### Installation
```bash
cd gateway
npm install
```

### Start Server
```bash
npm start
```

The server will start on port 8080. Nodemon will auto-reload on code changes.

### Test the Gateway

#### Option 1: Enhanced Day 2 Test UI (Recommended)
1. **Open browser**: Navigate to `http://localhost:8080/test`
2. **Click "Find Leader"**: Discover current RAFT leader
3. **Send test strokes**: Type message and click "Send Stroke"
4. **Monitor stats**: View sent/acknowledged/error counts

#### Option 2: Original Test UI
1. **Open browser**: Navigate to `http://localhost:8080`
2. **Use basic interface**: Test WebSocket connection

### API Endpoints (Day 2)

#### `GET /`
Original test UI page with WebSocket connection demo

#### `GET /test`
Enhanced Day 2 test UI with leader discovery and stroke routing

#### `GET /health`
Returns gateway health status
```json
{
  "status": "healthy",
  "service": "miniraft-gateway",
  "connectedClients": 2,
  "uptime": 123.45,
  "timestamp": "2026-04-04T15:00:00.000Z"
}
```

#### `GET /stats`
Returns gateway statistics (updated for Day 2)
```json
{
  "connectedClients": 2,
  "totalMessagesReceived": 15,
  "totalBroadcasts": 0,
  "strokesForwarded": 8,
  "strokesFailed": 2,
  "knownLeader": "1",
  "knownLeaderUrl": "http://localhost:5001",
  "uptime": 123.45
}
```

#### `GET /discover-leader`
Manually trigger leader discovery (new in Day 2)
```json
{
  "success": true,
  "leaderUrl": "http://localhost:5001",
  "leaderId": "1",
  "timestamp": "2026-04-04T15:00:00.000Z"
}
```

#### WebSocket Messages (Day 2)

**Send Stroke:**
```javascript
ws.send(JSON.stringify({
  type: 'stroke',
  content: 'test stroke data',
  timestamp: Date.now()
}));
```

**Receive Acknowledgment:**
```json
{
  "type": "ack",
  "message": "Stroke forwarded to leader",
  "leaderId": "1",
  "timestamp": 1775316994000
}
```

**Receive Error:**
```json
{
  "type": "error",
  "message": "Failed to forward stroke to leader",
  "error": "No leader available",
  "retry": true
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8080 | Gateway HTTP/WebSocket port |
| `REPLICA_URLS` | `http://localhost:5001,http://localhost:5002,http://localhost:5003` | Comma-separated replica URLs |

## Architecture (Day 2)

```
Browser Clients (WebSocket)
        ↓
    Gateway Server (THIS)
        ↓
 discoverLeader() ← polls all replicas
        ↓
 ensureLeaderUrl() ← caches result
        ↓
 forwardStrokeToLeader() ← routes to /client-stroke
        ↓
  Leader Processes Stroke
        ↓
 (Day 3: Leader Commits & Notifies Gateway)
        ↓
 (Day 3: Gateway Broadcasts to All Clients)
```

## Key Functions (Day 2)

### `fetchReplicaStatus(url)`
Polls a single replica's `/health` endpoint with 500ms timeout.
Returns health status, role, term, and leader info.

### `discoverLeader()`
Polls all replicas in parallel to find current leader.
Returns leader URL or null if no leader elected.
Caches result in `knownLeaderUrl` and `knownLeaderId`.

### `ensureLeaderUrl()`
Returns cached leader URL if available, otherwise triggers discovery.
Used before every stroke forward operation.

### `forwardStrokeToLeader(strokeData, maxRetries=3)`
Forwards stroke to leader's `/client-stroke` endpoint.
Implements exponential backoff retry logic.
Auto-rediscovers leader on failure.
Returns success/failure status.

## File Structure

```
gateway/
├── server.js          # Main gateway server (Day 2 ✓)
├── test-day2.html     # Enhanced test UI (Day 2 ✓)
├── package.json       # Dependencies
├── nodemon.json       # Auto-reload config
├── .gitignore         # Git ignore rules
└── README.md          # This file
```

## Dependencies

- **express**: HTTP server framework
- **ws**: WebSocket library
- **axios**: HTTP client for replica communication
- **nodemon**: Dev dependency for auto-reload

## Testing Checklist - Day 2

- [x] Leader discovery works when leader exists
- [x] Discovery returns null when no leader
- [x] Strokes forward to leader successfully
- [x] Retry logic works on failure
- [x] Exponential backoff implemented
- [x] WebSocket acknowledgments sent
- [x] Error messages sent on failure
- [x] Stats endpoint shows forwarding counts
- [x] Test UI displays leader information
- [x] Manual discovery endpoint works

## Integration Notes

### Expected Replica Endpoints (Day 2)

Replicas must implement:
- `GET /health` - Returns `{ replicaId, role, term, leader, logLength }`
- `POST /client-stroke` - Accepts stroke data (to be tested on Day 3)

### Testing with Replicas

1. Start all 3 replicas on ports 5001, 5002, 5003
2. One replica should become leader via election
3. Gateway will auto-discover the leader
4. Send strokes via test UI
5. Verify strokes reach leader (check replica logs)

## Next Steps

Tomorrow (Day 3), we will:
1. Implement `/replica-commit` endpoint (called by leader)
2. Add committed entry caching with deduplication
3. Implement broadcast function to all WebSocket clients
4. Test real-time sync across multiple browser tabs

---

**Status**: Day 2 Complete ✅  
**Next**: Day 3 - Broadcasting Committed Entries  
**Estimated Completion**: Day 6 (On Schedule)

