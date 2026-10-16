# MiniRAFT drawing board

A cloud computing college project: a shared canvas backed by three replicas running a small Raft implementation. It explores leader election, majority commits and recovery after a node stops.

## Run

Install Docker with Compose, then from the repo root:

```sh
docker compose up --build -d
```

Open [localhost:8080](http://localhost:8080) in two tabs. Draw in either tab and check the [cluster dashboard](http://localhost:8080/dashboard). No `.env` file is needed. The stack uses Node.js 22, Express, WebSocket and Nginx, with plain JavaScript in the browser.

## What it does

- Shared pen, eraser, undo/redo, clear and PNG export.
- Keeps drawing with one replica down. The remaining two elect a replacement if the leader stops; restarted replicas catch up.
- Shows pending marks, retries through elections and reconnects, and displays quorum and recovery status.

## How it works

The browser sends drawing operations through Nginx to the gateway. The gateway batches them for the leader, which replicates its log to the followers. Once two replicas acknowledge an entry, it can commit. The gateway reads committed entries in order and broadcasts them to every tab. Undo and clear go through that same log.

Dotted marks are still pending. Without a majority, they remain unconfirmed until you retry. The log, votes and terms live in memory: `docker compose down` ends the session and clears the board. This is a local learning project, with no accounts or durable storage.

## Test and demo

With Node.js 22 installed:

```sh
npm ci --prefix gateway
npm ci --prefix replica
npm test
node scripts/failoverDemo.js
```

Tests start their own local processes. The demo needs the Compose stack running; it draws three lines, stops a follower and then the leader, and restores both. Watch the dashboard alongside it.

See the [protocol and development notes](docs-and-reference/ARCHITECTURE.md) and the [original assignment](docs-and-reference/MiniRAFT.pdf).
