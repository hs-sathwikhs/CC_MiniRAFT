# API Specification

## 1. Vote Request
Endpoint: /request-vote  
Method: POST  

Request:
{
  term: number,
  candidateId: number
}

Response:
{
  voteGranted: true/false
}

---

## 2. Append Entries
Endpoint: /append-entries  
Method: POST  

Request:
{
  term: number,
  leaderId: number,
  entries: []
}

Response:
{
  success: true/false
}

---

## 3. Heartbeat
Endpoint: /heartbeat  
Method: POST  

Request:
{
  term: number,
  leaderId: number
}

Response:
{
  success: true/false
}

---

## 4. Sync Log
Endpoint: /sync-log  
Method: POST  

Request:
{
  missingFromIndex: number
}

Response:
{
  entries: []
}