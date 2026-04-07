# API Specification

## Overview
These endpoints are **internal RPC calls between replicas** in the RAFT cluster.  
They are not exposed directly to clients (clients communicate via Gateway).

Content-Type: application/json  

## 1. Request Vote

**Endpoint:** /request-vote  
**Method:** POST  

### Request
```json
{
  "term": 1,
  "candidateId": 2,
  "lastLogIndex": 10,
  "lastLogTerm": 1
}

Response:
{
  "term": 1,
  "voteGranted": true
}



## 2. Append Entries
Endpoint: /append-entries  
Method: POST  

Request:
{
  "term": 1,
  "leaderId": 1,
  "prevLogIndex": 9,
  "prevLogTerm": 1,
  "entries": [],
  "leaderCommit": 8
}

Response:
{
  "term": 1,
  "success": true
}



## 3. Heartbeat
Endpoint: /heartbeat  
Method: POST  

Request:
{
  "term": 1,
  "leaderId": 1,
  "entries": []
}


## 4. Sync Log
Endpoint: /sync-log  
Method: POST  

Request:
{
  "missingFromIndex": 5
}

Response:
{
  "entries": []
}

## Error Handling

{
  "success": false,
  "message": "Error description"
}