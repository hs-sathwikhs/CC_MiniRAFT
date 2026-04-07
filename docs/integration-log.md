# Integration Log — Day 3

## System Status
- docker-compose up: ✅
- replica1 running (port 5001): ✅
- replica2 running (port 5002): ✅
- replica3 running (port 5003): ✅
- gateway running (port 8080): ✅
- frontend running (port 3000): ✅

## RAFT Election Observed
- Split vote in Term 1 between Replica1 and Replica3
- Replica3 won election in Term 2 with 3/3 votes
- Replica3 became LEADER ✅
- Replica1, Replica2 became FOLLOWERS ✅
- Election timeout and retry working ✅
- Higher term wins correctly ✅

## Test Results
| Test | Result | Issue # |
|---|---|---|
| docker-compose up | ✅ | - |
| Replicas start as followers | ✅ | - |
| RAFT election happens | ✅ | - |
| Leader elected correctly | ✅ | - |
| Frontend loads | ✅ | #1 |
| WebSocket connects | ❌ | #2 |
| Drawing sends stroke | ❌ | #2 |
| Two tabs sync | ❌ | #2 |
| Stroke persists on refresh | ❌ | #2 |

## Issues Created
- Issue #1 — canvas.js missing WebSocket → @PES2UG24CS818

