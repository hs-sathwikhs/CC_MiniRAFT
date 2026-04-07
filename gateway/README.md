# Mini-RAFT Gateway

**Author**: Sathwik HS  
**Component**: WebSocket Gateway for RAFT-based Collaborative Drawing Board

## Overview

The Gateway is the traffic controller for the entire Mini-RAFT system. It:
- Accepts WebSocket connections from multiple browser clients
- Routes drawing strokes to the current RAFT leader replica
- Polls for committed entries and broadcasts them to all connected clients
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

### ✅ Day 3: Broadcasting Committed Entries (COMPLETED)
- [x] Fixed endpoint mismatch: `/client-stroke` → `/stroke` (matches replica API)
- [x] Implemented `pollCommittedEntries()` - fetch new commits every 200ms
- [x] Implemented `broadcastStroke()` - send strokes to all WebSocket clients
- [x] Added stroke history cache with deduplication
- [x] Implemented full-log sync on client connection
- [x] Added broadcasting metrics to `/stats` endpoint
- [x] Started commit polling on server startup
- [x] Removed test artifacts (test-day2.html)
- [x] **Deliverable**: Real-time stroke synchronization across all clients ✓

### ✅ Day 4: Failover & Health Monitoring (COMPLETED)
- [x] Implemented periodic leader health checks (every 5 seconds)
- [x] Added automatic leader rediscovery on failure detection
- [x] Implemented failure threshold (2 consecutive failures)
- [x] Enhanced error handling during elections
- [x] Added graceful shutdown for monitoring intervals
- [x] Updated `/stats` endpoint with failover metrics
- [x] **Deliverable**: Seamless failover with zero client disconnections ✓

## Architecture

### Data Flow (Day 3-4)

```
Frontend Canvas
    │
    │ WebSocket: { type: "stroke", stroke: {...} }
    ↓
Gateway (port 8080)
    │
    │ HTTP POST /stroke
    ↓
RAFT Leader (port 5001/5002/5003)
    │
    │ Replicates to followers
    │ Commits when majority acknowledges
    ↓
Gateway polls /committed (200ms intervals)
    │
    │ Detects new commits
    │ Broadcasts to all clients
    ↓
All Frontend Clients
    │
    └─ Real-time synchronized drawing
    
┌─────────────────────────────────┐
│ Background: Health Monitoring   │
│ - Checks leader every 5s        │
│ - Detects failures (2x timeout) │
│ - Auto-rediscovers new leader   │
│ - No client disconnections      │
└─────────────────────────────────┘
```

### Polling Strategy

Instead of callbacks, the gateway uses **active polling**:
- Polls `/committed?fromIndex=N` every 200ms
- Tracks last seen commit index
- Deduplicates using `{term}-{index}` keys
- Low latency (~200ms) for stroke appearance

**Why polling?** No changes needed to replica code - works with existing API.

### Failover Strategy (Day 4)

The gateway handles leader failures transparently:

**Detection:**
- Health check every 5 seconds via `/health` endpoint
- Verifies replica still has `role: "leader"`
- 2 consecutive failures trigger rediscovery

**Recovery:**
1. Clear cached leader URL/ID
2. Run `discoverLeader()` to find new leader
3. Resume polling and forwarding automatically
4. Clients stay connected throughout failover

**During Elections:**
- Commit polling gracefully handles timeouts
- Stroke forwarding retries with exponential backoff
- No error spam in logs during normal elections

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
Returns gateway statistics (updated for Day 4)
```json
{
  "connectedClients": 2,
  "totalMessagesReceived": 15,
  "totalBroadcasts": 12,
  "strokesForwarded": 8,
  "strokesFailed": 2,
  "knownLeader": "1",
  "knownLeaderUrl": "http://localhost:5001",
  "committedStrokesSeen": 12,
  "lastCommitIndex": 11,
  "strokeHistorySize": 12,
  "pollingActive": true,
  "healthMonitoringActive": true,
  "leaderFailureCount": 0,
  "lastHealthCheck": 1712456789000,
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

#### WebSocket Messages (Day 3)

**Client Sends Stroke:**
```javascript
ws.send(JSON.stringify({
  type: 'stroke',
  clientId: 'client-abc123',
  stroke: {
    x0: 100, y0: 150,
    x1: 105, y1: 155,
    color: '#ff0000'
  }
}));
```

**Gateway Broadcasts Committed Stroke:**
```json
{
  "type": "stroke",
  "stroke": {
    "x0": 100, "y0": 150,
    "x1": 105, "y1": 155,
    "color": "#ff0000"
  }
}
```

**On Connection - Full Canvas Sync:**
```json
{
  "type": "full-log",
  "strokes": [
    { "x0": 10, "y0": 20, "x1": 15, "y1": 25, "color": "#00ff00" },
    { "x0": 100, "y0": 150, "x1": 105, "y1": 155, "color": "#ff0000" }
  ],
  "count": 2
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

