# Shipyard — self-hosted CI/CD (Node.js · gRPC · MongoDB · React)

```
                 ┌──────────────── Master ────────────────┐
  Browser ──HTTP─┤  Express REST API  +  Socket.IO (live)  │
  (React UI)     │  MongoDB: pipelines, runs, jobs, logs   │
                 │  gRPC hub :50051                        │
                 └───────▲───────────────▲─────────────────┘
                         │ gRPC stream   │ gRPC stream   (agents dial out → works behind NAT)
                 ┌───────┴──────┐ ┌──────┴───────┐
                 │ Agent web-1  │ │ Agent db-1   │  … one per deploy server
                 │ runs bash    │ │ runs bash    │
                 └──────────────┘ └──────────────┘
```

| Folder   | What it is |
|----------|------------|
| `proto/` | `agent.proto` — the gRPC contract between master and agents |
| `master/`| Node.js master: REST API, auth, MongoDB models, gRPC agent hub, job dispatcher, live logs |
| `agent/` | Node.js agent installed on every deploy server; runs pipeline steps as shell scripts |
| `web/`   | React (Vite) UI with a Monaco-based shell script editor |

## Features

- **Pipelines** = ordered shell steps + env vars + target servers (pick agents individually or by label, e.g. `production`).
- **Parallel fan-out**: one run → one job per target server, each with its own live log.
- **Shell editor** (Monaco, bundled locally — no CDN): bash/sh/zsh/PowerShell highlighting, 25 deploy snippets
  (`git-sync`, `npm-build`, `pm2-reload`, `docker-build`, `compose-up`, `healthcheck`, `release-dir`, …) via Ctrl+Space,
  `$` autocomplete for CI and pipeline variables, a linter for common mistakes (`rm -rf $VAR/`, `cd` without error handling,
  unclosed `if`/`do`/`case`, `sudo` prompts, `read`), full-screen mode, Ctrl+S to save.
- **Live logs** over WebSocket with ANSI colours, per-step collapse, durations, exit codes.
- **Step options**: timeout, continue on error. **Cancel** kills the whole process group on the server.
- **Secrets**: mark env vars secret → never returned to the browser, masked as `••••••` in logs.
- **Webhooks**: each pipeline has a tokenised URL (GitHub/GitLab push → deploy). Body is exposed as `$CI_TRIGGER_PAYLOAD`.
- **Resilient agents**: auto-reconnect with backoff, heartbeats (load/memory), jobs queue while a server is offline and start when it reconnects.
- Optional **TLS** for gRPC.

Variables available in every step: `CI`, `CI_WORKSPACE`, `CI_RUN_ID`, `CI_RUN_NUMBER`, `CI_PIPELINE_NAME`, `CI_JOB_ID`,
`CI_AGENT_NAME`, `CI_STEP_NAME`, `CI_STEP_INDEX`, `CI_TRIGGER`, `CI_TRIGGERED_BY`, `CI_TRIGGER_PAYLOAD`, plus your pipeline env vars.

## Quick start (Docker)

```bash
cp master/.env.example .env      # set ADMIN_PASSWORD, JWT_SECRET, AGENT_TOKEN
docker compose up --build
```
Open http://localhost:4000 and sign in. A `demo-agent` is already connected — create a pipeline, tick it, Run.

## Quick start (without Docker)

Needs Node 18+ and MongoDB.

```bash
# 1. Master
cd master && cp .env.example .env && npm install && npm run dev     # API on :4000, gRPC on :50051

# 2. Web UI (dev server with hot reload, proxies /api to :4000)
cd web && npm install && npm run dev                                 # http://localhost:5173

# 3. An agent (on the same machine for testing)
cd agent && cp .env.example .env    # MASTER_ADDR=localhost:50051, same AGENT_TOKEN as master
npm install && npm start
```

For production, build the UI and let the master serve it:
```bash
cd web && npm run build && cp -r dist ../master/public
cd ../master && NODE_ENV=production npm start
```

## Installing the agent on a deploy server

```bash
sudo mkdir -p /opt/cicd-agent
sudo cp -r agent/* /opt/cicd-agent/ && sudo cp -r proto /opt/cicd-agent/proto
cd /opt/cicd-agent && sudo npm ci --omit=dev
sudo cp .env.example .env && sudo nano .env      # MASTER_ADDR, AGENT_TOKEN, AGENT_NAME, AGENT_LABELS
sudo useradd -r -m deploy                        # the user your scripts run as
sudo cp cicd-agent.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now cicd-agent
journalctl -u cicd-agent -f
```
The agent shows up on the **Agents** page within a second. Steps run as the `deploy` user in
`AGENT_WORKSPACE/<pipeline-name>` (kept between runs, so `git fetch` is fast) or in the pipeline's working directory.

## Webhook example (GitHub)

Repository → Settings → Webhooks → Payload URL = the URL shown on the pipeline page, content type `application/json`.
Inside a step:
```bash
BRANCH=$(echo "$CI_TRIGGER_PAYLOAD" | jq -r '.ref' | sed 's#refs/heads/##')
[ "$BRANCH" = "main" ] || { echo "Ignoring $BRANCH"; exit 0; }
```

## gRPC protocol (proto/agent.proto)

Agents open one bidirectional stream `AgentService.Connect`:

- agent → master: `Register` (token, name, labels) · `Heartbeat` · `LogChunk` · `StepUpdate` · `JobResult`
- master → agent: `Registered` · `JobAssignment` (steps, env, shell, working dir) · `CancelJob`

Because the agent dials out, deploy servers need no open inbound ports — only the master exposes `:50051`.

### TLS
Master: `GRPC_TLS_CERT=/path/server.crt GRPC_TLS_KEY=/path/server.key`.
Agent: `GRPC_TLS=true` (public CA) or `GRPC_TLS_CA=/path/ca.crt` (self-signed).

## REST API (all under `/api`, Bearer token from `/auth/login`)

| Method | Path | |
|---|---|---|
| POST | `/auth/login` | `{username,password}` → `{token}` |
| GET | `/agents` · DELETE `/agents/:id` | list / remove offline agent |
| GET, POST | `/pipelines` | list (with last run) / create |
| GET, PUT, DELETE | `/pipelines/:id` | |
| POST | `/pipelines/:id/run` | `{env:{KEY:"override"}}` optional |
| POST | `/pipelines/:id/webhook-token` | rotate token |
| POST | `/hooks/:id?token=…` | webhook trigger (no login) |
| GET | `/runs?pipeline=&status=&limit=` · GET `/runs/:id` | |
| POST | `/runs/:id/cancel` | |
| GET | `/jobs/:id/logs` | |

Socket.IO events: `agents:update`, `run:update`, `job:update`, `log` (after `subscribe:job`).

## Notes and limits

- One admin login from env vars. Swap `master/src/auth.js` for a users collection if you need multiple accounts/roles.
- Each agent runs one job at a time (others queue on the agent). Run several agents per host if you need parallelism.
- If the master restarts, jobs that were running are marked failed; queued jobs survive and dispatch when agents reconnect.
- Agent names must be unique — a second agent with the same name replaces the first connection.
- Scripts run with the agent user's permissions. Treat UI access like shell access to every connected server, and use TLS + a strong `AGENT_TOKEN`.
