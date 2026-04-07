# MiniRAFT Collaborative Drawing Board

A fault-tolerant, real-time collaborative drawing application built on the RAFT consensus algorithm. Multiple users can draw simultaneously on a shared canvas with automatic synchronization, leader election, and graceful failover handling.

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/)
[![WebSocket](https://img.shields.io/badge/WebSocket-RFC%206455-blue)](https://tools.ietf.org/html/rfc6455)
[![RAFT](https://img.shields.io/badge/RAFT-Consensus-orange)](https://raft.github.io/)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

---

## 🎯 Project Overview

This project demonstrates a production-grade implementation of the RAFT consensus algorithm applied to a real-world use case: collaborative drawing. It showcases distributed systems concepts including leader election, log replication, fault tolerance, and real-time client synchronization.

### Key Features

- **Real-time Collaboration**: Multiple users draw simultaneously with sub-second synchronization
- **Fault Tolerance**: Automatic recovery from replica failures without data loss
- **Leader Election**: Dynamic leader selection using RAFT consensus protocol
- **Zero Downtime**: Clients remain connected during leader failovers
- **Scalable Architecture**: Clean separation between client gateway and consensus cluster
- **Production Ready**: Comprehensive error handling, logging, and monitoring

---

## 🏗️ System Architecture

### High-Level Overview

```
┌─────────────────────────────────────────────────────────────┐
│                       Browser Clients                       │
│          (Multiple users drawing on shared canvas)          │
└─────────────────────────────────────────────────────────────┘
                              │
                    WebSocket Connections
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Gateway (Port 8080)                      │
│   • Routes strokes to leader                                │
│   • Polls for committed entries                             │
│   • Broadcasts to all clients                               │
│   • Handles failover transparently                          │
└─────────────────────────────────────────────────────────────┘
                              │
                    HTTP/REST (POST /stroke)
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    RAFT Cluster                             │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐               │
│  │ Replica1 │    │ Replica2 │    │ Replica3 │               │
│  │ (5001)   │◄──►│ (5002)   │◄──►│ (5003)   │               │
│  └──────────┘    └──────────┘    └──────────┘               │
│       │               │               │                     │
│   Leader         Follower        Follower                   │
│   (elected)                                                 │
└─────────────────────────────────────────────────────────────┘
```

### Component Breakdown

#### 🎨 Frontend (Canvas UI)
- **Technology**: HTML5 Canvas, Vanilla JavaScript
- **Responsibilities**:
  - Render drawing canvas with mouse/touch support
  - Capture user strokes and send to gateway
  - Receive and render committed strokes from other users
  - Auto-reconnect on disconnection
- **Port**: 3000 (via http-server) or direct file access
- **Location**: `frontend/`

#### 🌐 Gateway (WebSocket Server)
- **Technology**: Node.js, Express, WebSocket (ws library)
- **Responsibilities**:
  - Accept and manage WebSocket connections from clients
  - Discover and track current RAFT leader
  - Forward client strokes to leader replica
  - Poll leader for newly committed entries
  - Broadcast committed strokes to all connected clients
  - Handle leader failover transparently
  - Monitor cluster health
- **Port**: 8080
- **Location**: `gateway/`
- **Documentation**: See [gateway/README.md](gateway/README.md) for detailed API

#### 🔷 RAFT Replicas (Consensus Cluster)
- **Technology**: Node.js, Express, Axios
- **Responsibilities**:
  - Implement RAFT consensus algorithm
  - Elect leader via majority voting
  - Replicate log entries across followers
  - Maintain consistency via term and index tracking
  - Commit entries when majority acknowledges
  - Provide health and status endpoints
- **Ports**: 5001, 5002, 5003
- **Location**: `replica1/`, `replica2/`, `replica3/`
- **Replication**: Identical codebase, different environment variables

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+ and npm 9+
- **Git** for cloning the repository
- (Optional) **Docker** and Docker Compose for containerized deployment

### One-Command Start

#### On Windows (PowerShell):
```bash
npm start
```

#### On Linux/Mac:
```bash
npm run start:bash
```

This will:
1. Install all dependencies (if needed)
2. Start all 3 RAFT replicas
3. Start the gateway server
4. Start the frontend server
5. Display all service URLs and monitoring endpoints

**Access the application**: Open your browser to `http://localhost:3000`

### Manual Start (Development)

If you prefer to start services individually:

```bash
# Terminal 1: Start Replica 1
cd replica1 && npm install && npm start

# Terminal 2: Start Replica 2
cd replica2 && npm install && npm start

# Terminal 3: Start Replica 3
cd replica3 && npm install && npm start

# Terminal 4: Start Gateway
cd gateway && npm install && npm start

# Terminal 5: Start Frontend
npx http-server frontend -p 3000
```

### Docker Deployment

For containerized deployment:

```bash
# Start all services
docker compose up --build

# Stop all services
docker compose down
```

### Stopping Services

Press `Ctrl+C` in the terminal where the quick-start script is running. All services will shut down gracefully.

---

## 🧪 Testing & Demo

### Basic Functionality Test

1. Open `http://localhost:3000` in **multiple browser tabs** (or different browsers)
2. Draw in one tab and watch strokes appear in real-time across all tabs
3. Each client gets a unique color automatically
4. New tabs load with full canvas history

### Failover Test

1. Start all services
2. Check current leader: `curl http://localhost:8080/discover-leader`
3. Draw some strokes to verify synchronization
4. Kill the leader process (e.g., if leader is replica1: `Ctrl+C` in Terminal 1)
5. Wait ~10 seconds for election to complete
6. Draw more strokes - should work seamlessly with new leader!
7. Check new leader: `curl http://localhost:8080/discover-leader`

### Monitoring

**Gateway Statistics**:
```bash
curl http://localhost:8080/stats | jq
```

**Replica Health**:
```bash
curl http://localhost:5001/health | jq
curl http://localhost:5002/health | jq
curl http://localhost:5003/health | jq
```

**View Logs**:
All logs are stored in `logs/` directory:
- `replica1.log`, `replica2.log`, `replica3.log`
- `gateway.log`
- `frontend.log`

---

## 📊 How It Works

### Stroke Flow (Normal Operation)

1. **User draws** on canvas in browser
2. **Frontend** sends stroke via WebSocket to gateway:
   ```json
   { type: "stroke", stroke: { x0, y0, x1, y1, color } }
   ```
3. **Gateway** forwards to current leader replica via HTTP:
   ```
   POST /stroke → Leader Replica
   ```
4. **Leader** appends entry to its log and replicates to followers
5. **Followers** acknowledge the entry
6. **Leader** commits entry when majority responds (2/3 replicas)
7. **Gateway** polls `/committed` endpoint every 200ms
8. **Gateway** detects new commit and broadcasts to all clients
9. **All clients** receive and render the stroke simultaneously

### Leader Election (Failover)

1. **Failure detected**: Gateway health check fails 2 consecutive times
2. **Cache cleared**: Gateway clears cached leader URL/ID
3. **Discovery triggered**: Gateway polls all replicas for `/health`
4. **Replicas elect**: RAFT algorithm runs election among replicas
5. **New leader**: Replica with highest term and majority votes becomes leader
6. **Gateway discovers**: Finds new leader via health checks
7. **Resume operations**: Stroke forwarding resumes automatically
8. **Clients unaware**: No disconnections or visible interruption

### Data Consistency

- **Log Replication**: Every stroke is a log entry with term and index
- **Commit Rules**: Only committed when majority acknowledges
- **Deduplication**: Gateway uses `{term}-{index}` keys to prevent duplicates
- **Ordering**: Commit index ensures correct stroke order
- **State Sync**: New clients receive full history on connection

---

## 🛠️ Technologies Used

### Backend
- **Node.js** - JavaScript runtime
- **Express** - HTTP server framework
- **ws** - WebSocket server implementation
- **Axios** - HTTP client for inter-service communication

### Frontend
- **HTML5 Canvas** - Drawing surface
- **WebSocket API** - Real-time bidirectional communication
- **Vanilla JavaScript** - No frameworks for simplicity

### DevOps
- **Docker & Docker Compose** - Containerization
- **http-server** - Static file serving
- **nodemon** - Development auto-reload

---

## 📁 Project Structure

```
miniraft/
├── frontend/                # Canvas UI and client-side logic
│   ├── index.html          # Main HTML page
│   └── canvas.js           # Drawing and WebSocket logic
│
├── gateway/                # WebSocket gateway server
│   ├── server.js           # Main gateway implementation
│   ├── package.json        # Dependencies
│   └── README.md           # Gateway-specific documentation
│
├── replica1/               # RAFT replica instance 1
│   ├── index.js            # RAFT consensus implementation
│   └── package.json        # Dependencies
│
├── replica2/               # RAFT replica instance 2 (identical to replica1)
├── replica3/               # RAFT replica instance 3 (identical to replica1)
│
├── docs/                   # Documentation and specifications
│   ├── api-spec.md         # RAFT API specifications
│   ├── architecture.md     # System architecture
│   └── failure-scenarios.md # Failure handling documentation
│
├── start.ps1               # Quick start script (PowerShell)
├── start.sh                # Quick start script (Bash)
├── docker-compose.yml      # Docker orchestration
├── package.json            # Root package with scripts
└── README.md               # This file
```

---

## 👥 Team & Responsibilities

| Team Member | Component | Responsibilities |
|-------------|-----------|------------------|
| **Sathwik HS** | Gateway | WebSocket server, leader discovery, broadcasting, failover handling |
| **Satwik Bankapur** | RAFT Replicas | Consensus algorithm, leader election, log replication, state machine |
| **Prajwal** | Frontend | Canvas UI, drawing logic, WebSocket client, auto-reconnect |
| **Sudarshan** | DevOps | Docker configuration, deployment, orchestration, documentation |

---

## 🎓 Learning Outcomes

This project demonstrates understanding of:

- **Distributed Systems**: Consensus algorithms, fault tolerance, replication
- **Network Programming**: WebSocket, HTTP/REST, client-server communication
- **Asynchronous Programming**: Promises, async/await, event-driven architecture
- **System Design**: Separation of concerns, stateless services, polling vs push
- **Production Practices**: Logging, monitoring, error handling, graceful shutdown

---

## 🔧 Advanced Configuration

### Environment Variables

Each component can be configured via environment variables:

**Gateway**:
- `PORT`: Server port (default: 8080)
- `REPLICA_URLS`: Comma-separated replica URLs

**Replicas**:
- `REPLICA_ID`: Replica identifier (1, 2, or 3)
- `PORT`: Server port (5001, 5002, or 5003)
- `DOCKER_ENV`: Set to enable Docker service discovery

### Scaling Considerations

**Horizontal Scaling**:
- Frontend: Stateless, can scale infinitely
- Gateway: Currently single-instance (could scale with shared state/Redis)
- Replicas: Fixed at 3 for RAFT quorum (odd number required)

**Performance**:
- Gateway handles ~500 concurrent WebSocket connections
- RAFT cluster supports ~100 strokes/second with 200ms commit latency
- Memory capped at 1,000 strokes (oldest trimmed automatically)

---

## 📈 Monitoring & Observability

### Health Checks

All services expose `/health` endpoints:
- Gateway: `http://localhost:8080/health`
- Replicas: `http://localhost:500[1-3]/health`

### Metrics

Gateway exposes detailed metrics at `/stats`:
- Client connections, message counts, broadcast stats
- Leader information, failure counts
- Commit polling status, stroke history size

### Logs

Structured logs with timestamps in `logs/` directory. Format:
```
[timestamp] [SERVICE] [category] message {json-data}
```

---

## 🐛 Troubleshooting

### Issue: Services won't start
- **Solution**: Check Node.js version (18+), run `npm run install-all`

### Issue: Strokes not syncing
- **Solution**: Check gateway stats for active polling, verify leader is elected

### Issue: Leader election stuck
- **Solution**: Restart all replicas, ensure no port conflicts

### Issue: Memory growing
- **Solution**: Verify stroke history caps at 1,000 (check gateway stats)

For more issues, see component-specific READMEs and documentation in `docs/`.

