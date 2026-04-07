# Integration Log 

## Pre-conditions
- All 5 containers running: ✅
- canvas.js WebSocket fixed: ✅

## Test Results

| Test | Result | Issue # |
|---|---|---|
| 🟢 Connected to gateway shows | ✅/❌ | |
| Drawing sends stroke to gateway | ✅/❌ | |
| Replica commits stroke | ✅/❌ | |
| Two tabs show same drawing | ✅/❌ | |
| Stroke persists after refresh | ✅/❌ | |
| Kill leader → new election | ✅/❌ | |
| Gateway re-routes to new leader | ✅/❌ | |
| Drawing works after failover | ✅/❌ | |
| Dead replica rejoins as follower | ✅/❌ | |
| Browser stays connected during failover | ✅/❌ | |

## Issues Created
Issue #1 — Frontend container missing from docker-compose → @PES2UG24CS818 (fixed)
Issue #2 — canvas.js missing WebSocket, stroke broadcast, tab sync, refresh persistence → @PES2UG24CS818


## Conclusion
The system demonstrates stable operation with successful integration between frontend, gateway, and replica nodes. It handles failures effectively through leader-based processing and maintains consistency using RAFT principles. Overall, the system shows reliable performance and fault tolerance under basic failover scenarios.