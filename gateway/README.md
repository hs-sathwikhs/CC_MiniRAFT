# MiniRAFT Gateway

A WebSocket gateway server that routes client drawing strokes to a RAFT-based consensus cluster and broadcasts committed entries to all connected clients in real-time.

**Author**: Sathwik HS  
**Part of**: MiniRAFT Collaborative Drawing Board

---

## Overview

The Gateway acts as a traffic controller between browser clients and the RAFT replica cluster. It handles:

- **Client Connections**: Accepts WebSocket connections from multiple browser clients
- **Stroke Routing**: Forwards drawing strokes to the current RAFT leader for replication
- **Leader Discovery**: Automatically discovers and tracks the current cluster leader
- **Broadcasting**: Polls for committed entries and broadcasts them to all connected clients
- **Failover Handling**: Transparently handles leader failures and elections without disconnecting clients
- **State Synchronization**: Sends full canvas history to newly connected clients

---

## Architecture

### System Flow

```
┌─────────────────┐
│ Browser Client  │ ──WebSocket──┐
└─────────────────┘              │
                                 │
┌─────────────────┐              │      ┌──────────────────┐
│ Browser Client  │ ──WebSocket──┼─────▶│  Gateway (8080)  │
└─────────────────┘              │      └──────────────────┘
                                 │              │
┌─────────────────┐              │              │ HTTP POST /stroke
│ Browser Client  │ ──WebSocket──┘              ▼
└─────────────────┘                    ┌──────────────────┐
                                       │  RAFT Leader     │
                                       │  (5001/5002/5003)│
                                       └──────────────────┘
                                                │
                                                │ Replicate
                                                ▼
                                       ┌──────────────────┐
                                       │  RAFT Followers  │
                                       └──────────────────┘
                                                │
                                                │ Commit (majority)
                                                ▼
                                       Gateway polls /committed
                                       (every 200ms)
                                                │
                                                ▼
                                       Broadcast to all clients
```

### Key Components

**Leader Discovery**
- Polls all replicas' `/health` endpoints to find current leader
- Caches leader URL to minimize discovery overhead
- Automatically rediscovers on forwarding failures

**Commit Polling**
- Fetches newly committed entries from leader every 200ms
- Uses incremental fetching (tracks last seen commit index)
- Deduplicates using `{term}-{index}` keys
- Prevents request overlap with in-flight guard

**Health Monitoring**
- Checks leader health every 5 seconds
- Detects leader failures (2 consecutive timeouts)
- Triggers automatic rediscovery
- No client disconnections during failover

**Memory Management**
- Stroke history capped at 1,000 entries
- Automatically trims oldest strokes
- Prevents unbounded growth in long sessions

---

## Quick Start

### Prerequisites

- Node.js 18+ installed
- npm or yarn package manager
- RAFT replica cluster running (ports 5001, 5002, 5003)

### Installation

```bash
cd gateway
npm install
```

### Configuration

Set environment variables (optional):

```bash
# Gateway port (default: 8080)
export PORT=8080

# Replica URLs (comma-separated)
export REPLICA_URLS="http://localhost:5001,http://localhost:5002,http://localhost:5003"
```

For Docker deployment:
```bash
export REPLICA_URLS="http://replica1:5001,http://replica2:5002,http://replica3:5003"
```

### Running

**Development mode** (with auto-reload):
```bash
npm start
```

**Production mode**:
```bash
npm run prod
```

The server will start on `http://localhost:8080`

### Stopping

Press `Ctrl+C` or send `SIGTERM` for graceful shutdown.

---

## API Reference

### HTTP Endpoints

#### `GET /health`
Returns gateway health status.

**Response:**
```json
{
  "status": "healthy",
  "service": "miniraft-gateway",
  "connectedClients": 3,
  "uptime": 123.45,
  "timestamp": "2026-04-07T03:00:00.000Z"
}
```

#### `GET /stats`
Returns detailed gateway statistics.

**Response:**
```json
{
  "connectedClients": 3,
  "totalMessagesReceived": 150,
  "totalBroadcasts": 120,
  "strokesForwarded": 80,
  "strokesFailed": 2,
  "clearsForwarded": 3,
  "clearsFailed": 0,
  "knownLeader": "1",
  "knownLeaderUrl": "http://localhost:5001",
  "committedStrokesSeen": 120,
  "lastCommitIndex": 119,
  "strokeHistorySize": 120,
  "pollingActive": true,
  "healthMonitoringActive": true,
  "leaderFailureCount": 0,
  "lastHealthCheck": 1712456789000,
  "validationFailures": 8,
  "rateLimitHits": 4,
  "activeRateLimits": 2,
  "uptime": 123.45
}
```

#### `GET /discover-leader`
Manually trigger leader discovery (returns current leader).

**Response:**
```json
{
  "success": true,
  "leaderUrl": "http://localhost:5001",
  "leaderId": "1",
  "timestamp": "2026-04-07T03:00:00.000Z"
}
```

---

### WebSocket Protocol

**Connection**: `ws://localhost:8080`

#### Client → Gateway Messages

**Send Drawing Stroke:**
```json
{
  "type": "stroke",
  "clientId": "client-abc123",
  "stroke": {
    "x0": 100,
    "y0": 150,
    "x1": 105,
    "y1": 155,
    "color": "#ff0000",
    "width": 2,
    "tool": "pen"
  }
}
```

**Clear Canvas:**
```json
{
  "type": "clear",
  "clientId": "client-abc123"
}
```

#### Gateway → Client Messages

**Welcome (on connect):**
```json
{
  "type": "welcome",
  "message": "Connected to Mini-RAFT Gateway",
  "clientId": "client-abc123"
}
```

**Full Canvas History (on connect):**
```json
{
  "type": "full-log",
  "strokes": [
    {
      "x0": 10, "y0": 20,
      "x1": 15, "y1": 25,
      "color": "#00ff00"
    },
    {
      "x0": 100, "y0": 150,
      "x1": 105, "y1": 155,
      "color": "#ff0000"
    }
  ],
  "count": 2
}
```

**Committed Stroke Broadcast:**
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

**Stroke Acknowledgment:**
```json
{
  "type": "ack",
  "message": "Stroke forwarded to leader",
  "leaderId": "1",
  "timestamp": 1712456789000
}
```

**Clear Acknowledgment:**
```json
{
  "type": "ack",
  "message": "Clear command forwarded to leader",
  "leaderId": "1",
  "timestamp": 1712456789000
}
```

**Error:**
```json
{
  "type": "error",
  "message": "Failed to forward stroke to leader",
  "error": "Service temporarily unavailable",
  "retry": true
}
```

**Validation Error:**
```json
{
  "type": "error",
  "message": "x0 must be a finite number",
  "validation": false
}
```

**Rate Limit Error:**
```json
{
  "type": "error",
  "message": "Rate limit exceeded. Please slow down.",
  "rateLimited": true
}
```

---

## Integration with RAFT Cluster

### Required Replica Endpoints

The gateway expects the following endpoints on each replica:

**`GET /health`**
- Returns: `{ replicaId, role, term, leader, logLength }`
- Used for: Leader discovery

**`POST /stroke`**
- Body: `{ stroke: {...} }`
- Returns: `{ success: true/false, entry?: {...} }`
- Used for: Forwarding client strokes to leader

**`POST /clear`**
- Body: `{ clientId: "..." }`
- Returns: `{ success: true/false, entry?: {...} }`
- Used for: Forwarding clear commands to leader

**`GET /committed?from=N`**
- Query param: `from` (start index, inclusive)
- Returns: `{ entries: [...], commitIndex: N }`
- Used for: Polling committed entries

---

## Design Decisions

### Why Polling Instead of Callbacks?

**Polling Strategy:**
- No changes needed to replica code
- Works with existing RAFT API
- Simple coordination between components
- 200ms latency is acceptable for drawing

**Alternatives Considered:**
- Push-based (requires `/replica-commit` endpoint on gateway)
- WebHooks (adds complexity)
- Long-polling (unnecessary for this use case)

### Why Cache Leader?

- Reduces discovery overhead (no need to poll all replicas per stroke)
- Invalidated automatically on forwarding failures
- Periodic health checks detect stale cache

### Why In-Flight Guard?

- Prevents request storms under load
- 200ms interval + 500ms timeout could overlap
- Guarantees single concurrent poll

### Why Cap Stroke History?

- Prevents unbounded memory growth
- 1,000 strokes ≈ reasonable canvas snapshot
- Could be replaced with server-side canvas rendering

---

## Monitoring & Observability

### Logging

All logs follow this format:
```
[timestamp] [GATEWAY] [category] message {data}
```

**Example:**
```
[2026-04-07T03:00:00.000Z] [GATEWAY] New client connected {"clientId":"client-123","totalClients":3}
```

### Metrics (via `/stats`)

**Connection Metrics:**
- `connectedClients`: Current WebSocket connections
- `totalMessagesReceived`: Lifetime message count

**Forwarding Metrics:**
- `strokesForwarded`: Successfully forwarded to leader
- `strokesFailed`: Failed forwarding attempts
- `clearsForwarded`: Successfully forwarded clear commands
- `clearsFailed`: Failed clear attempts

**Broadcasting Metrics:**
- `totalBroadcasts`: Strokes sent to clients
- `committedStrokesSeen`: Unique committed entries
- `strokeHistorySize`: Current history size

**Health Metrics:**
- `pollingActive`: Commit polling running
- `healthMonitoringActive`: Leader health checks running
- `leaderFailureCount`: Consecutive failures
- `lastHealthCheck`: Timestamp of last success

**Security Metrics:**
- `validationFailures`: Total rejected strokes
- `rateLimitHits`: Total rate-limited requests
- `activeRateLimits`: Clients currently tracked

---

## Production Considerations

### Scaling

**Horizontal Scaling:**
- Not currently supported (single gateway instance)
- Multiple gateways would need shared state or sticky sessions
- Consider Redis pub/sub for multi-gateway broadcast

**Vertical Scaling:**
- Low CPU/memory footprint
- Primarily I/O bound (WebSocket + HTTP)
- Can handle hundreds of clients per instance

### Security

**Current State (Production-Ready):**
- ✅ **Input Validation**: All stroke data validated before forwarding
- ✅ **Rate Limiting**: 100 requests/second per client with violation tracking
- ✅ **Error Sanitization**: Internal details never exposed to clients
- ✅ **Request Size Limits**: 2MB maximum payload size
- ✅ **Response Validation**: Replica responses validated before processing
- ⚠️ **No Authentication**: Any client can connect (suitable for educational use)
- ⚠️ **No TLS**: Assumes reverse proxy handles encryption

**Input Validation:**
```javascript
// Stroke validation checks:
// - All coordinates are finite numbers
// - Coordinate limits (prevent DoS via huge numbers)
// - Width between 1-100 (if provided)
// - Color in #RRGGBB format (if provided)
// - Tool is 'pen' or 'eraser' (if provided)
```

**Rate Limiting:**
- Max 100 requests per second per client
- Violation tracking (5 violations = 60 second block)
- Metrics tracked in `/stats` endpoint

**Error Sanitization:**
- Internal URLs replaced with `[REDACTED_URL]`
- IP addresses replaced with `[REDACTED_IP]`
- Stack traces removed
- Generic messages for common errors

**Production Recommendations (Optional):**
- Add JWT authentication for multi-tenant use
- Use WSS (WebSocket over TLS) via reverse proxy
- Add CORS configuration for specific origins
- Implement audit logging for compliance
- Add circuit breakers for replica calls

### Error Handling

**Graceful Degradation:**
- Stroke forwarding retries (3 attempts, exponential backoff)
- Commit polling tolerates leader downtime
- Health checks trigger automatic rediscovery
- Clients auto-reconnect on disconnection

**Known Limitations:**
- No request queueing during elections
- No partial stroke recovery on failure
- No persistent stroke history (memory-only)

---

## Troubleshooting

### Gateway can't find leader

**Symptoms**: All stroke forwards fail, `/stats` shows `knownLeader: null`

**Solutions:**
1. Check replicas are running: `curl http://localhost:5001/health`
2. Verify `REPLICA_URLS` environment variable
3. Check replica logs for election issues
4. Manually trigger discovery: `curl http://localhost:8080/discover-leader`

### Strokes not appearing for other clients

**Symptoms**: Drawing works locally but not synced

**Solutions:**
1. Check `/stats` - is `pollingActive: true`?
2. Check replica leader has committed entries: `curl http://localhost:5001/committed?from=0`
3. Check browser console for WebSocket errors
4. Verify query parameter is correct (`from` not `fromIndex`)

### Memory usage growing

**Symptoms**: Gateway memory increases over time

**Solutions:**
1. Check `strokeHistorySize` in `/stats` - should cap at 1,000
2. Check for memory leaks in Node.js (use `--inspect`)
3. Restart gateway periodically (Docker restart policy)
4. Verify trimming logs appear after 1,000 strokes

### WebSocket connections dropping

**Symptoms**: Clients disconnect frequently

**Solutions:**
1. Check reverse proxy timeout settings
2. Increase client reconnect max attempts
3. Add WebSocket ping/pong keepalives
4. Check network stability

---

## Development

### Project Structure

```
gateway/
├── server.js           # Main server implementation
├── package.json        # Dependencies and scripts
├── nodemon.json        # Auto-reload configuration
├── .gitignore          # Git ignore rules
└── README.md           # This file
```

### Dependencies

- **express**: HTTP server framework
- **ws**: WebSocket server implementation
- **axios**: HTTP client for replica communication
- **nodemon** (dev): Auto-reload on file changes

### Testing

**Manual Testing:**
1. Start 3 replicas on ports 5001-5003
2. Start gateway: `npm start`
3. Open frontend in multiple browser tabs
4. Draw in one tab, verify appears in others
5. Kill leader replica, verify failover works

**Automated Testing:**
```bash
# TODO: Add integration tests
npm test
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Gateway HTTP/WebSocket port |
| `REPLICA_URLS` | `http://localhost:5001,http://localhost:5002,http://localhost:5003` | Comma-separated replica URLs |

---

## License

Part of MiniRAFT project - Educational implementation of RAFT consensus algorithm.

---

## Contributing

This is a course project. For issues or improvements, contact the development team.

**Team Members:**
- Sathwik HS
- Satwik Bankapur
- Prajwal
- Sudarshan