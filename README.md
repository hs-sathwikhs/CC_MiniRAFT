# Distributed Whiteboard (RAFT)

## Day 1 Setup

* Frontend canvas created
* Basic docker-compose structure added
* Gateway + 3 replicas scaffolded

## How to Run (Day 1)

### Option 1: Frontend only

1. Open `frontend/index.html` in your browser.
2. Draw on the canvas using mouse drag.

### Option 2: Full stack using Docker

1. Make sure Docker Desktop is running.
2. From project root, run:

```bash
docker compose up --build
```

3. Open `http://localhost:8080`.

### Stop containers

```bash
docker compose down
```
