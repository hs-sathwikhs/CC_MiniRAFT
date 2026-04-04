# System Architecture

## Components
- Frontend (Canvas UI)
- Gateway (WebSocket server)
- Replicas (RAFT nodes)

## Flow
Client → Gateway → Leader → Followers

## Explanation
- Client sends drawing strokes to Gateway
- Gateway forwards to Leader replica
- Leader replicates data to followers
- Once majority confirms → data is committed

## Notes
- Leader handles all writes
- Followers stay in sync
- System tolerates node failure using RAFT