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

### 🔜 Day 2: Leader Discovery & Routing (PENDING)
- [ ] Implement `discoverLeader()` function
- [ ] Poll replicas' `/status` endpoints
- [ ] Forward strokes to leader's `/client-stroke` endpoint
- [ ] Handle no-leader scenarios with retry logic

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

1. **Open browser**: Navigate to `http://localhost:8080`
2. **Open multiple tabs**: Open 2-3 tabs with the same URL
3. **Send messages**: Type messages in any tab
4. **Verify echo**: You should see the server echoing back your messages

### API Endpoints (Day 1)

#### `GET /`
Test UI page with WebSocket connection demo

#### `GET /health`
Returns gateway health status
```json
{
  "status": "healthy",
  "service": "miniraft-gateway",
  "connectedClients": 2,
  "uptime": 123.45,
  "timestamp": "2026-04-03T18:23:00.000Z"
}
```

#### `GET /stats`
Returns gateway statistics
```json
{
  "connectedClients": 2,
  "totalMessagesReceived": 15,
  "totalBroadcasts": 0,
  "knownLeader": null,
  "uptime": 123.45
}
```

#### WebSocket Connection
```javascript
const ws = new WebSocket('ws://localhost:8080');

ws.onopen = () => {
  console.log('Connected');
  ws.send(JSON.stringify({ type: 'test', content: 'Hello' }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Received:', data);
};
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8080 | Gateway HTTP/WebSocket port |
| `REPLICA_URLS` | `http://localhost:5001,http://localhost:5002,http://localhost:5003` | Comma-separated replica URLs |

## Architecture

```
Browser Clients (WebSocket)
        ↓
    Gateway Server (THIS)
        ↓
 Discover Leader Replica
        ↓
   Forward Strokes
        ↓
  Leader Commits Entry
        ↓
 Leader Notifies Gateway
        ↓
Gateway Broadcasts to All Clients
```

## File Structure

```
gateway/
├── server.js          # Main gateway server (Day 1 ✓)
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

## Next Steps

Tomorrow (Day 2), we will:
1. Implement leader discovery by polling replica `/status` endpoints
2. Route incoming strokes to the current leader
3. Handle scenarios where no leader exists

## Testing Checklist - Day 1

- [x] Server starts without errors
- [x] Browser can connect via WebSocket
- [x] Multiple tabs can connect simultaneously
- [x] Messages are echoed back correctly
- [x] Disconnection is handled gracefully
- [x] Health endpoint returns correct data
- [x] Stats endpoint shows connected clients
- [x] Logs show all connection events

## Notes

- Currently in **echo mode** - messages are sent back to sender only
- No replica communication yet (Day 2+)
- No broadcasting to other clients yet (Day 3+)
- Focus on WebSocket stability and connection handling

---

**Status**: Day 1 Complete ✅  
**Next**: Day 2 - Leader Discovery & Routing  
**Estimated Completion**: Day 6 (On Schedule)
