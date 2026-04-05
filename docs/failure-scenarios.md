# Failure Scenarios

## Overview
This document describes possible failure scenarios in the RAFT-based distributed system and how the system handles them to maintain consistency and availability.

---

## 1. Leader Failure

### Problem
- The current leader node crashes or becomes unreachable.

### Solution
- Followers detect missing heartbeats.
- A new election is triggered.
- One follower becomes the new leader based on majority votes.
- Gateway updates and routes requests to the new leader.

---

## 2. Leader Failure During Replication

### Problem
- Leader crashes while replicating data to followers.

### Solution
- Some followers may have incomplete data.
- Only committed entries (majority confirmed) are preserved.
- New leader continues from the last committed log.
- Uncommitted entries are discarded to maintain consistency.

---

## 3. Network Partition

### Problem
- Network splits nodes into multiple groups.

### Solution
- Majority partition continues functioning.
- Minority partition cannot elect a leader.
- When network is restored, logs are synchronized from the leader.

---

## 4. Follower Crash

### Problem
- A follower node stops working.

### Solution
- System continues if majority of nodes are active.
- Leader continues replication with remaining nodes.
- Restarted follower requests missing logs using sync mechanism.

---

## 5. Gateway Failure

### Problem
- Gateway server crashes or restarts.

### Solution
- Clients reconnect automatically.
- Gateway resumes communication with current leader.
- No data loss as replicas maintain state.

---

## 6. Split Vote (Election Conflict)

### Problem
- Multiple candidates start election simultaneously.

### Solution
- Votes are split, no leader is elected.
- Election restarts after timeout.
- Randomized timeout ensures one candidate eventually wins.

---

## Conclusion
The system ensures fault tolerance using RAFT consensus by maintaining majority agreement, leader election, and log consistency across replicas.