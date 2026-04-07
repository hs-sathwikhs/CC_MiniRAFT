# System Architecture

## Components
- Frontend (Canvas UI)
- Gateway (WebSocket server)
- Replicas (RAFT nodes)

## Flow
Normal path: Client → Gateway → Leader → Followers
Failover path: Client → Gateway → old Leader/not-leader replica → Gateway refreshes leader → new Leader → Followers

## Explanation
- Client sends drawing strokes to Gateway
- Gateway forwards each stroke to the replica it currently believes is the RAFT leader
- Leader replicates data to followers
- Once a majority confirms, the stroke is committed and can be acknowledged to the client

## Leader discovery and updates
- The Gateway keeps a cached view of the current leader
- If a replica responds with a redirect/not-leader error, the Gateway updates its cached leader and retries the stroke against the reported leader
- The cached leader may also be refreshed periodically or updated from RAFT election notifications, if available
- Until a new leader is known, the Gateway should treat leader selection as unresolved rather than assuming the previous leader is still valid

## Behavior during leader changes
- In-flight strokes sent during an election may be delayed, rejected for retry, or require replay to the new leader
- To avoid duplicate strokes after retry, each stroke should carry a stable client/request identifier so retries are idempotent
- The Gateway should buffer or retry unacknowledged strokes until they are either committed by the new leader or reported back to the client as failed
- Clients may temporarily see increased latency during failover, but should not see committed strokes lost or duplicated

## Notes
- Leader handles all writes
- Followers stay in sync
- System tolerates node failure using RAFT, including leader re-election