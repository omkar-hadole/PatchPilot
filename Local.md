# Complete Guide: Running & Deploying Byter + TrueForge

This document is the exhaustive, zero-to-running operational and deployment guide for **Byter** built for the [WeMakeDevs TrueForge Agent Harness Hackathon](https://www.wemakedevs.org/hackathons/trueforge).

It provides complete, copy-paste-ready instructions for:
1. **Local Development (Part 1)**: Zero-to-running local stack (TrueForge Harness + Byter Backend + Live React Dashboard + Smee Webhook Tunnel + One-Time UI Configuration).
2. **Multi-Service Railway Deployment (Part 2)**: Full production cloud setup (Service 1: TrueForge Agent Harness + Service 2: Byter CI & Dashboard, connected via MCP and public webhooks).
3. **Reference Architecture & Troubleshooting (Parts 3 & 4)**: Network topology, port matrices, security screening rules, and edge-case resolution.

---

## Architecture Breakdown

Byter operates as an autonomous CI system for bug reports using a decoupled **two-service architecture**:

```
                               ┌─────────────────────────────────────────────────────────────┐
                               │                 Local or Railway Environment                │
                               │                                                             │
┌─────────────────┐           │   ┌────────────────────────┐      ┌─────────────────────┐   │
│   GitHub Repo   │           │   │  Service 1: TrueForge  │      │   Service 2: Byter  │   │
│   (Issues, PRs) │           │   │  - Agent Execution Loop│◄────►│  - Webhook Intake   │   │
└────────┬────────┘           │   │  - OpenAI gpt-5.6-sol  │      │  - Verification FSM │   │
         │                    │   │  - Sandbox Execution   │      │  - GitHub MCP Server│   │
         │ Webhooks           │   │  - Session Persistence │      │  - Human Review UI  │   │
         ▼                    │   └────────────────────────┘      └──────────┬──────────┘   │
┌─────────────────┐           │                                              │              │
│ Webhook Tunnel  │───────────┼──────────────────────────────────────────────┘              │
│ (Smee / Prod)   │           │                                                             │
└─────────────────┘           └─────────────────────────────────────────────────────────────┘
```

### Component Roles & Interaction Contracts

- **Service 1: TrueForge Agent Harness (`@truefoundry/trueforge`)**
  - Connects model inference (`openai/gpt-5.6-sol`) and manages multi-turn agent execution loops.
  - In Standalone mode (`STANDALONE=true`), manages an embedded SQLite session database and local process sandboxes without requiring external Postgres or Redis clusters.
  - Queries Byter's GitHub MCP Server over HTTP JSON-RPC to inspect code and submit verified proof contracts.
- **Service 2: Byter CI, Dashboard & GitHub MCP Server (`@byter/server`)**
  - Ingests GitHub webhooks (`issues`, `issue_comment`) with HMAC-SHA256 signature verification and prompt injection screening.
  - Orchestrates a 20-state deterministic finite state machine (FSM) enforcing a **strict 3/3 target failure reproduction rule**.
  - Hosts the remote GitHub Model Context Protocol (MCP) server providing read tools (`read_issue`, `read_file`, `submit_byter_result`) and gated write tools (`create_fix_pull_request`).
  - Serves the live React 19 observability dashboard and enforces a human-in-the-loop maintainer approval gate before publishing draft pull requests.

---

## Part 1: Zero-to-Running Local Development Guide

### 1. System Prerequisites

Ensure the following runtimes and credentials are ready on your machine:

| Prerequisite | Minimum Version | Verification Command | Notes / Source |
| :--- | :--- | :--- | :--- |
| **Node.js** | `^20.19.0` or `>=22.12.0` (Node 22+ recommended) | `node -v` | Core JavaScript runtime |
| **pnpm** | `>=10.0.0` (pnpm 10+) | `pnpm -v` | Monorepo package manager (`npm i -g pnpm`) |
| **Git** | Any modern version | `git --version` | Version control system |
| **OpenAI API Key** | `OPENAI_API_KEY` | [OpenAI Platform](https://platform.openai.com/) | Active key with access to `gpt-5.6-sol` |
| **GitHub Token** | `ghp_...` | [GitHub Personal Access Tokens](https://github.com/settings/tokens) | Token with `repo` (issues, comments, contents, PRs) scope |

---

### 2. Workspace Setup & Automated Verification

#### 2.1 Clone and Install

```bash
git clone https://github.com/MAYANK-MAHAUR/Byter.git
cd Byter
pnpm install
```

#### 2.2 Monorepo Package Topology

The repository contains **7 packages** (1 root + 6 workspace packages):

| # | Package Name | Workspace Directory | Role & Description | Test Files & Count |
|---|---|---|---|---|
| 1 | `byter` (root) | `.` | Monorepo orchestrator scripts (`verify`, `build`, `lint`, `typecheck`, `test`, `dev`, `start`) | Workspace delegation |
| 2 | `@byter/core` | `packages/core` | 20-state FSM (`state-machine.ts`), prompt injection & dangerous shell scanner (`security.ts`), domain types | 2 files &rarr; **9 tests** |
| 3 | `@byter/agent` | `packages/agent` | TrueForge SDK runtime (`runtime.ts`), Agent spec, native tool approval resume, and instructions generator (`byter-agent.ts`) | 1 file &rarr; **10 tests** |
| 4 | `@byter/github` | `packages/github` | GitHub REST client (`client.ts`), HMAC-SHA256 webhook validator (`webhook.ts`), App auth (`app-auth.ts`) | 3 files &rarr; **14 tests** |
| 5 | `@byter/github-mcp` | `apps/github-mcp` | Remote JSON-RPC 2.0 MCP server hosting 6 GitHub MCP tools (`http.ts`, `tools.ts`) | 2 files &rarr; **15 tests** |
| 6 | `@byter/server` | `apps/server` | Production HTTP server: `/healthz`, `/mcp`, `/api/github/webhook`, `/api/approvals`, static SPA | 2 files &rarr; **29 tests** |
| 7 | `@byter/web` | `apps/web` | React 19 + Vite dashboard: live triage view, evidence visualizer, markdown/LaTeX viewer, approval UI | 1 file &rarr; **2 tests** |

#### 2.3 Run Automated Verification Suite

Run `pnpm verify` to execute all 4 verification phases:
```bash
pnpm verify
```

**Verification Phases Executed:**
1. `pnpm build`: Compiles all workspace packages via TypeScript project references.
2. `pnpm lint`: Validates source code against linting rules.
3. `pnpm typecheck`: Validates strict static types across all 7 packages (`tsc --noEmit`).
4. `pnpm test`: Runs **11 test files** and passes all **79/79 tests** across the monorepo.

---

### 3. Local Configuration (`.env`)

Create your `.env` file in the project root:

```bash
# On Linux / macOS / Git Bash:
cp .env.example .env

# On Windows PowerShell:
Copy-Item .env.example .env
```

#### Environment Variables Reference Table

| Variable | Local Default | Description | Required |
| :--- | :--- | :--- | :--- |
| `PORT` | `8787` | HTTP port for Byter API & webhook intake server | Yes |
| `DATA_DIR` | `.data-local` | Directory path for JSONL persistence (`webhook-runs.jsonl`, `approvals.jsonl`) | Yes |
| `APP_BASE_URL` | `http://127.0.0.1:8787` | Canonical base URL for dashboard and GitHub issue comment links | Yes |
| `APPROVAL_TOKEN` | `local-approval-secret-token` | Bearer token authenticating maintainer approval requests | Yes |
| `GITHUB_WEBHOOK_SECRET` | `local-webhook-secret` | Shared secret for HMAC-SHA256 signature verification | Yes |
| `BYTER_API_TARGET` | `http://127.0.0.1:8787` | Proxy target for Vite dev server (`apps/web`) | Yes |
| `VITE_BYTER_API_URL` | *(empty)* | Direct API URL (leave empty for relative proxy routing) | Optional |
| `MODEL_PROVIDER` | `openai` | Model provider for TrueForge agent spec | Yes |
| `MODEL_NAME` | `gpt-5.6-sol` | OpenAI model identifier | Yes |
| `OPENAI_API_KEY` | `sk-...` | OpenAI API key with access to `gpt-5.6-sol` | Yes |
| `TRUEFORGE_URL` | `http://localhost:3000` | Base URL of local TrueForge harness | Yes |
| `TRUEFORGE_API_KEY` | `local-trueforge-key` | Token passed in headers to TrueForge | Yes |
| `TRUEFORGE_MCP_SERVER_NAME` | `byter-github` | Identifier of MCP connector registered in TrueForge | Yes |
| `MCP_AUTH_TOKEN` | `local-mcp-secret-token` | Shared secret Bearer token authenticating TrueForge calls to Byter's `/mcp` | Yes |
| `GITHUB_TOKEN` | `ghp_...` | GitHub Personal Access Token or App token with repo permissions | Yes |
| `BYTER_REQUIRE_TRIGGER_LABEL` | `true` | When true, only triages issues with `BYTER_TRIGGER_LABEL` | Yes |
| `BYTER_TRIGGER_LABEL` | `byter:run` | GitHub label required to trigger Byter | Yes |

#### Copy-Paste `.env` Template

```env
# =============================================================
# 1. Byter Local Server & Persistence
# =============================================================
PORT=8787
DATA_DIR=.data-local
APP_BASE_URL=http://127.0.0.1:8787
APPROVAL_TOKEN=local-approval-secret-token
GITHUB_WEBHOOK_SECRET=local-webhook-secret

# =============================================================
# 2. Local Dashboard Web UI (Vite)
# =============================================================
BYTER_API_TARGET=http://127.0.0.1:8787
VITE_BYTER_API_URL=

# =============================================================
# 3. Model Provider & OpenAI Credentials
# =============================================================
MODEL_PROVIDER=openai
MODEL_NAME=gpt-5.6-sol
OPENAI_API_KEY=<your-openai-api-key>

# =============================================================
# 4. TrueForge Local Agent Harness
# =============================================================
TRUEFORGE_URL=http://localhost:3000
TRUEFORGE_API_KEY=local-trueforge-key
TRUEFORGE_MCP_SERVER_NAME=byter-github
MCP_AUTH_TOKEN=local-mcp-secret-token

# =============================================================
# 5. GitHub Integration & Trigger Policy
# =============================================================
GITHUB_TOKEN=<your-github-token>
BYTER_REQUIRE_TRIGGER_LABEL=true
BYTER_TRIGGER_LABEL=byter:run
```

---

### 4. Step-by-Step Local Execution (4 Terminals)

Open 4 separate terminal windows in your workspace root (`c:\Users\hp\Documents\antigravity\keen-hertz`):

```
┌───────────────────────────────────────┬───────────────────────────────────────┐
│ Terminal 1: TrueForge Agent Harness   │ Terminal 2: Byter Backend Server      │
│ http://localhost:3000                 │ http://127.0.0.1:8787                 │
├───────────────────────────────────────┼───────────────────────────────────────┤
│ Terminal 3: Byter Live Dashboard      │ Terminal 4: Smee Webhook Proxy        │
│ http://127.0.0.1:5173                 │ Smee.io -> Localhost:8787             │
└───────────────────────────────────────┴───────────────────────────────────────┘
```

#### Terminal 1 — Start TrueForge Locally

TrueForge runs in Standalone mode with an embedded SQLite database:

- **Windows PowerShell:**
  ```powershell
  $env:STANDALONE="true"; npx @truefoundry/trueforge@latest
  ```
- **Linux / macOS Bash:**
  ```bash
  STANDALONE=true npx @truefoundry/trueforge@latest
  ```
- **Verification:** Open `http://localhost:3000` in your browser.

---

#### Terminal 2 — Start the Byter Backend Server

Starts the Byter REST API, JSONL persistence engine, GitHub MCP server, and webhook receiver:

- **Windows PowerShell:**
  ```powershell
  $env:PORT="8787"; $env:DATA_DIR=".data-local"; pnpm --filter @byter/server start
  ```
- **Linux / macOS Bash:**
  ```bash
  PORT=8787 DATA_DIR=.data-local pnpm --filter @byter/server start
  ```
- **Verification:**
  - PowerShell: `Invoke-RestMethod -Uri http://127.0.0.1:8787/healthz` (Returns `@{ok=True}`)
  - Bash: `curl http://127.0.0.1:8787/healthz` (Returns `{"ok":true}`)

---

#### Terminal 3 — Start the Byter Live Dashboard UI

Launches the React 19 + Vite dashboard for live run visualization, proof inspection, and maintainer review:

- **Windows PowerShell:**
  ```powershell
  $env:BYTER_API_TARGET="http://127.0.0.1:8787"; pnpm dev
  ```
- **Linux / macOS Bash:**
  ```bash
  BYTER_API_TARGET=http://127.0.0.1:8787 pnpm dev
  ```
- **Verification:** Open `http://127.0.0.1:5173` in your browser to view the Byter dashboard.

---

#### Terminal 4 — Forward Live GitHub Webhooks via Smee.io

GitHub cannot send webhooks directly to `localhost`. Smee.io creates a persistent outbound SSE tunnel to proxy webhooks to your local machine:

1. Open [https://smee.io/](https://smee.io/) in your browser and click **Start a new channel**.
2. Copy your generated channel URL (e.g. `https://smee.io/aBcDeFg12345`).
3. Start the Smee client:
   - **Windows PowerShell:**
     ```powershell
     npx smee -u https://smee.io/<your_channel_id> --target http://127.0.0.1:8787/api/github/webhook
     ```
   - **Linux / macOS Bash:**
     ```bash
     npx smee -u https://smee.io/<your_channel_id> --target http://127.0.0.1:8787/api/github/webhook
     ```
4. Output confirms connection: `Connected https://smee.io/<your_channel_id>`.

---

### 5. One-Time Click-by-Click TrueForge UI Configuration

Before triggering your first bug triage, open **`http://localhost:3000`** and configure the Model Provider and MCP Connector:

```
TrueForge Shell Header -> [Settings Icon]
  ├── [Models] -> OpenAI -> [Configure] -> Paste OPENAI_API_KEY -> [Create]
  └── [Connectors] -> [+ Add MCP Server] -> byter-github (API Key Auth) -> [Add]
```

#### Step A: Configure OpenAI Model Provider (`Settings → Models`)

1. Open `http://localhost:3000` in your browser.
2. In the top navigation / sidebar, click the **Settings** button (gear icon, `title="Settings"`).
3. In the Settings sidebar, click **Models** (`id="models"`, cpu icon).
4. Under the **AVAILABLE** providers section, locate **OpenAI** and click **Configure** (or click **+ Add Custom Provider**):
   - **Modal Title**: `Configure Provider Details`
   - **API key \*** (`id="model-provider-api-key"`): Paste your `OPENAI_API_KEY` (e.g., `sk-proj-...`).
   - *(Optional)* Expand **Advanced · custom endpoint** if using a custom gateway:
     - **Base URL** (`id="model-provider-base-url"`): Defaults to `https://api.openai.com/v1`.
5. Click **Create** (or **Save**).
6. Verify: The OpenAI provider now appears under **CONFIGURED** with a green **Connected** status dot, and `gpt-5.6-sol` is listed as an active catalog model.

---

#### Step B: Register Byter GitHub MCP Server (`Settings → Connectors`)

TrueForge needs to query Byter's GitHub MCP server for issue data, file inspection, and proof submission:

1. In the TrueForge Settings sidebar, click **Connectors** (`id="connectors"`, plug icon).
2. Click the **+ Add MCP Server** button in the top right.
3. Complete the **Add MCP server** form with exact values:
   - **Name \*** (`id="mcp-server-name"`): Enter `byter-github` *(Must match `TRUEFORGE_MCP_SERVER_NAME`)*.
   - **Description \*** (`id="mcp-server-description"`): Enter `Byter GitHub MCP Server`.
   - **URL \*** (`id="mcp-server-url"`): Enter `http://localhost:8787/mcp`.
   - **Auth type \*** (`name="mcp-auth-type"`): Select the **`API Key`** segmented radio pill.
   - **API key \*** (`id="mcp-server-api-key"`): Enter `Bearer local-mcp-secret-token` *(Must include the `Bearer ` prefix and match `MCP_AUTH_TOKEN`)*.
   - **Header name (optional)** (`id="mcp-server-header-name"`): Enter `Authorization` (or leave empty, defaults to `Authorization`).
4. Click **Add**.
5. **Verify MCP Discovery**:
   - `byter-github` appears under **Configured** with a green **Connected** status dot.
   - Click on the `byter-github` row to open `ConnectorDetails`. TrueForge automatically queries `tools/list` and displays all discovered tools:
     - `read_issue`: Fetches issue title, body, comments, and metadata.
     - `read_file`: Safely reads target files within repository boundaries.
     - `submit_byter_result`: Submits structured reproduction proofs and candidate patches.
     - `add_verified_label`: Applies verified label once 3/3 target failure check passes.
     - `create_fix_pull_request`: Gated tool invoked only upon maintainer approval.

---

### 6. GitHub Repository Webhook Configuration (Local Mode)

1. Open your GitHub target repository in your browser.
2. Navigate to **Settings** &rarr; **Webhooks** &rarr; click **Add webhook**.
3. Fill in the webhook form:
   - **Payload URL**: `https://smee.io/<your_channel_id>` (Your unique Smee channel URL).
   - **Content type**: Select `application/json` *(CRITICAL: never select `application/x-www-form-urlencoded`)*.
   - **Secret**: Enter the exact string set in `GITHUB_WEBHOOK_SECRET` in your `.env` (`local-webhook-secret`).
   - **SSL verification**: Select `Enable SSL verification`.
   - **Which events would you like to trigger this webhook?**:
     - Select **Let me select individual events**.
     - Check `[x] Issues` (actions: `opened`, `edited`, `reopened`, `labeled`).
     - Check `[x] Issue comments` (actions: `created`, for maintainer approval commands).
   - **Active**: Ensure checkbox is checked.
4. Click **Add webhook**. GitHub will send a test ping, which Smee forwards to Byter returning HTTP 200.

---

### 7. End-to-End Bug Reproduction & Maintainer Approval Flow

Byter executes a 4-stage lifecycle for every incoming bug report:

```
[Issue Created + byter:run] 
       │
       ▼
[Stage 1: Security Triage] ──(Pass)──► [Stage 2: TrueForge 3/3 Repro]
       │                                          │
    (Reject)                                   (3/3 Pass)
       │                                          ▼
   [Halt Run]                           [Stage 3: Pause at awaiting-approval]
                                                  │
                                          [Maintainer Review]
                                                  │
                                                  ▼
                                        [Stage 4: Publish Draft PR]
```

#### Stage 1: Issue Trigger & Security Screening
1. A developer opens an issue describing a bug and applies the `byter:run` label.
2. Webhook arrives at Byter's `/api/github/webhook`.
3. Byter verifies HMAC-SHA256 signature and applies a 60-second trigger deduplication window.
4. Byter runs the security scanner (`packages/core/src/security.ts`):
   - Screens issue text for prompt injections, secret extraction instructions (`print env`, `show tokens`), base64 evasion, and malicious shell command strings.
   - If unsafe, transitions to `rejected`, posts an alert on GitHub, and halts execution.
5. Byter applies the label `byter:triaging` (`#1d5fd1`) and posts an initial issue progress comment:
   ```markdown
   <!-- byter-run:run-1740936000-abc12345 -->
   ### 🤖 Byter — Autonomous Bug Triage & Verification

   - 🔍 **Status:** Analyzing issue and establishing TrueForge sandbox environment...
   - 📊 **Run ID:** `run-1740936000-abc12345`
   - 🔗 **[Open Byter Live Dashboard →](http://127.0.0.1:5173)**
   ```

#### Stage 2: Bug Reproduction & Verification in TrueForge
1. Byter creates an isolated TrueForge session with `openai/gpt-5.6-sol`.
2. TrueForge activates sandbox tools under `/tmp/byter-tools` and queries Byter's MCP server for issue data and source files.
3. **Strict 3/3 Target Failure Check**: The agent constructs a minimal reproducer test and must observe the failure 3 consecutive times (`3/3 matching failures`) before attempting a fix.
4. The agent writes a targeted patch, verifies the test passes, and runs regression suites.
5. The agent calls `submit_byter_result` with the structured proof contract.

#### Stage 3: Pausing at `awaiting-approval` Gate
1. The agent submits the proof contract, requests `create_fix_pull_request`, and TrueForge emits `tool.approval_required` before the MCP server receives the write.
2. Byter verifies that the pending TrueForge tool-call arguments hash to the same `patchHash = SHA256(canonical(patchArguments))` as the displayed candidate.
3. Byter updates GitHub labels: removes `byter:triaging` and applies `byter:verified` (`#8250df`) and `byter:awaiting-approval` (`#d1242f`).
4. Byter updates the GitHub issue comment with full verification evidence:
   ```markdown
   <!-- byter-run:run-1740936000-abc12345 -->
   ### 🤖 Byter — Bug Verified & Patch Ready (Awaiting Maintainer Approval)

   - ✅ **Reproduction:** 3/3 target failures observed before patch
   - ✅ **Validation:** Target test passes post-patch; 0 regressions detected
   - 🔒 **Patch SHA-256:** `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

   #### 📋 Proposed Patch Summary
   Fixes tokenizer backslash handling when escape sequences appear at string boundaries.

   > ⏸ **TrueForge is paused.** No branch, commit, or pull request has been created.

   👉 **[Review Evidence & Approve Patch on Dashboard →](http://127.0.0.1:5173)**  
   *Maintainers can also reply with `approve` or `/byter approve` directly on this issue.*
   ```

#### Stage 4: Maintainer Approval & Draft PR Publication
Maintainers can approve via two separate channels:
- **Channel A (Dashboard UI)**: Open `http://127.0.0.1:5173`, inspect the unified diff and proof traces, and click **Approve Patch** (sends `POST /api/approvals` with `APPROVAL_TOKEN`).
- **Channel B (GitHub Comment)**: A maintainer with `OWNER`, `admin`, `maintain`, or `write` permission comments `approve` or `/byter approve` on the issue.

**Outcome:**
1. Byter verifies `patchHash` and records cryptographic receipt in `DATA_DIR/approvals.jsonl`.
2. Byter sends a `user.tool_approval` decision to TrueForge for the exact stored thread and tool-call IDs. TrueForge resumes MCP write tool `create_fix_pull_request`:
   - Creates git branch `byter/fix-<issueNumber>-<shortHash>`.
   - Commits the validated fix files.
   - Publishes a **Draft Pull Request** linked to the issue.
3. Labels update: removes `byter:awaiting-approval` and applies `byter:pr-created` (`#1a7f37`).
4. Byter posts final comment linking to the Draft PR.

---

## Part 2: Complete Multi-Service Railway Deployment Guide

Deploying Byter to production on [Railway](https://railway.com/) uses **two interdependent services** in a single Railway project:

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    Railway Project: byter-production                            │
│                                                                                                 │
│  ┌──────────────────────────────────────────────┐     ┌──────────────────────────────────────┐  │
│  │ Service 1: trueforge (TrueForge Harness)     │     │ Service 2: byter (CI & Dashboard)    │  │
│  │ - Port: 8790                                 │     │ - Port: 3000                         │  │
│  │ - STANDALONE=true                            │◄────┼─ TRUEFORGE_URL                       │  │
│  │ - /data volume (SQLite persistence)          │     │ - /data volume (JSONL persistence)   │  │
│  │ - Public: trueforge-xxx.up.railway.app       │────►│ - MCP Server: /mcp                   │  │
│  │                                              │     │ - Public: byter-xxx.up.railway.app   │  │
│  └──────────────────────────────────────────────┘     └──────────────────▲───────────────────┘  │
│                                                                          │                      │
└──────────────────────────────────────────────────────────────────────────┼──────────────────────┘
                                                                           │ Webhooks
                                                                ┌──────────┴───────────┐
                                                                │  GitHub Repository   │
                                                                └──────────────────────┘
```

---

### Step 1: Create a Railway Project

1. Sign in to [Railway](https://railway.com/).
2. Click **+ New Project** &rarr; select **Empty Project**.
3. Click on the project name in the top bar and rename it to `byter-production`.

---

### Step 2: Deploy Service 1 (TrueForge Agent Harness)

1. Inside your Railway project, click **+ Create** &rarr; **Docker Image**.
2. Enter the official published TrueForge Docker image:
   ```text
   truefoundry/trueforge:latest
   ```
   *(Or `@truefoundry/trueforge:latest`)*
3. Click on the created service card &rarr; open the **Settings** tab:
   - **Service Name**: `trueforge`
4. Go to the **Networking** tab &rarr; click **Generate Domain** (e.g., `https://trueforge-production-xxxx.up.railway.app`).
5. Go to the **Volumes** tab &rarr; click **Add Volume**:
   - **Mount Path**: `/data` (ensures SQLite database and session history persist across restarts).
5. Go to the **Variables** tab and set the environment variables:

| Variable | Value | Description |
| :--- | :--- | :--- |
| `NODE_ENV` | `production` | Enables production optimizations |
| `PORT` | `8790` | Internal listening port for TrueForge backend |
| `HOST` | `0.0.0.0` | Bind address for container network |
| `STANDALONE` | `true` | **CRITICAL**: Enables embedded SQLite mode without Postgres/Redis |
| `PUBLIC_BASE_URL` | `https://<your-trueforge-domain>.up.railway.app` | Public HTTPS domain generated by Railway |
| `OPENAI_API_KEY` | `sk-proj-...` | OpenAI API key with quota for `gpt-5.6-sol` |

6. Click **Deploy**.
7. **Health Check Verification**: Once deployed, run:
   ```bash
   curl -f https://<your-trueforge-domain>.up.railway.app/healthz
   ```
   *Expected response: HTTP 200 OK.*

---

### Step 3: Deploy Service 2 (Byter CI & Dashboard)

1. In the same Railway project, click **+ Create** &rarr; **GitHub Repo** &rarr; select `MAYANK-MAHAUR/Byter`.
2. Click on the service card &rarr; open the **Settings** tab:
   - **Service Name**: `byter`
   - **Root Directory**: `/` (Leave as root)
   - **Builder**: Automatically detected from `Dockerfile` and `railway.json`
   - **Health Check Path**: `/healthz`
3. Go to the **Networking** tab &rarr; click **Generate Domain** (e.g., `https://byter-production-xxxx.up.railway.app`).
4. Go to the **Volumes** tab &rarr; click **Add Volume**:
   - **Mount Path**: `/data` (Ensures `webhook-runs.jsonl` and `approvals.jsonl` persist across deployments).
5. Go to the **Variables** tab and configure the production environment variables:

| Variable | Production Value | Description |
| :--- | :--- | :--- |
| `NODE_ENV` | `production` | Production environment mode |
| `PORT` | `3000` | Internal listening port for Byter server |
| `HOST` | `0.0.0.0` | Container bind address |
| `DATA_DIR` | `/data` | Directory for persistent JSONL run storage on mounted volume |
| `APP_BASE_URL` | `https://<your-byter-domain>.up.railway.app` | Public HTTPS domain for Byter service |
| `APPROVAL_TOKEN` | `<generate-secure-random-token>` | Secret Bearer token for maintainer approval API |
| `GITHUB_WEBHOOK_SECRET` | `<generate-secure-webhook-secret>` | Secret for HMAC-SHA256 webhook signature validation |
| `MODEL_PROVIDER` | `openai` | Model provider identifier |
| `MODEL_NAME` | `gpt-5.6-sol` | OpenAI model identifier |
| `OPENAI_API_KEY` | `sk-proj-...` | OpenAI API key |
| `TRUEFORGE_URL` | `https://<your-trueforge-domain>.up.railway.app` | Full HTTPS URL of deployed Service 1 (TrueForge) |
| `TRUEFORGE_API_KEY` | `<generate-trueforge-key>` | Shared key for TrueForge communication |
| `TRUEFORGE_MCP_SERVER_NAME` | `byter-github` | Identifier for MCP connector |
| `MCP_AUTH_TOKEN` | `<generate-secure-mcp-token>` | Bearer token authenticating TrueForge MCP calls to Byter `/mcp` |
| `GITHUB_TOKEN` | `ghp_...` | GitHub Personal Access Token or App token with repo permissions |
| `BYTER_REQUIRE_TRIGGER_LABEL` | `true` | Enforce trigger label requirement |
| `BYTER_TRIGGER_LABEL` | `byter:run` | GitHub label required to trigger triage |

6. Click **Deploy**. Railway will build the multi-stage container and start the Byter server.
7. **Health Check Verification**:
   ```bash
   curl -f https://<your-byter-domain>.up.railway.app/healthz
   ```
   *Expected response: `{"ok":true}`.*

---

### Step 4: Connect Byter's GitHub MCP Server in Railway TrueForge UI

Once both services are deployed on Railway, connect Byter's MCP tools inside the TrueForge interface:

1. Open your deployed TrueForge UI at `https://<your-trueforge-domain>.up.railway.app`.
2. Click **Settings** (gear icon in header/sidebar) &rarr; select **Models**:
   - Ensure **OpenAI** is configured with your `OPENAI_API_KEY` and shows `Connected` (green dot).
3. In Settings, select **Connectors** &rarr; click **+ Add MCP Server**:
   - **Name \***: `byter-github`
   - **Description \***: `Byter GitHub MCP Server (Railway Production)`
   - **URL \***: `https://<your-byter-domain>.up.railway.app/mcp`
   - **Auth type \***: Select **`API Key`** segmented radio pill.
   - **API key \***: Enter `Bearer <your-production-MCP_AUTH_TOKEN>` *(Must include `Bearer ` prefix)*.
   - **Header name (optional)**: `Authorization`.
4. Click **Add**.
5. Click on the newly added `byter-github` connector row to verify tools discovery (`read_issue`, `read_file`, `submit_byter_result`, `create_fix_pull_request`, `add_verified_label`).

---

### Step 5: Configure GitHub Repository Webhook for Railway

1. In your GitHub repository, navigate to **Settings** &rarr; **Webhooks** &rarr; **Add webhook**.
2. Fill in the webhook parameters:
   - **Payload URL**: `https://<your-byter-domain>.up.railway.app/api/github/webhook`
   - **Content type**: `application/json`
   - **Secret**: The exact value of `GITHUB_WEBHOOK_SECRET` configured in Railway Byter Variables.
   - **SSL verification**: `Enable SSL verification`.
   - **Which events would you like to trigger this webhook?**:
     - Select **Let me select individual events**.
     - Check `[x] Issues`
     - Check `[x] Issue comments`
   - **Active**: Checked.
3. Click **Add webhook**.

---

### Step 6: Live Smoke Testing & Production Verification

Execute these verification commands from your terminal:

```bash
# 1. Verify Service 1 (TrueForge) Health
curl -f https://<your-trueforge-domain>.up.railway.app/healthz

# 2. Verify Service 2 (Byter) Health
curl -f https://<your-byter-domain>.up.railway.app/healthz

# 3. Test Byter Latest Runs API
curl -f https://<your-byter-domain>.up.railway.app/api/runs/latest

# 4. Test Byter Remote MCP Endpoint with Bearer Auth
curl -X POST https://<your-byter-domain>.up.railway.app/mcp \
  -H "Authorization: Bearer <your-production-MCP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

```

#### Live End-to-End Test Procedure:
1. Open a new issue titled `Test Bug: Tokenizer trailing backslash crash` on your GitHub repo and add label `byter:run`.
2. Verify Byter adds label `byter:triaging` and posts progress comment with the live dashboard link.
3. Open `https://<your-byter-domain>.up.railway.app` to observe live trace events streamed from TrueForge.
4. Verify TrueForge runs 3/3 reproduction tests and transitions run to `awaiting-approval`.
5. Post a comment `approve` on the GitHub issue (or click **Approve Patch** on the dashboard).
6. Verify Byter creates the draft pull request, adds label `byter:pr-created`, and posts confirmation.

---

## Part 3: Architecture, Ports & Network Reference

| Component | Local Mode | Railway Production Mode | Protocol / Path | Purpose & Storage |
| :--- | :--- | :--- | :--- | :--- |
| **TrueForge Backend** | `http://localhost:3000` (Dev Proxy) / `8790` | `https://<trueforge-domain>.up.railway.app` (Port `8790`) | HTTP/WS, `/healthz`, `/api` | Model loop & SQLite DB (`/data/db/db.sqlite`) |
| **Byter Server & API** | `http://127.0.0.1:8787` | `https://<byter-domain>.up.railway.app` (Port `3000`) | HTTP, `/healthz`, `/api/runs/*` | Webhooks, state machine, proof validation |
| **GitHub MCP Server** | `http://localhost:8787/mcp` | `https://<byter-domain>.up.railway.app/mcp` | JSON-RPC 2.0 (`Bearer` Auth) | Tool provider queried by TrueForge |
| **Byter Dashboard UI** | `http://127.0.0.1:5173` (Vite) | Served from Byter root `/` | React 19 SPA | Live trace visualizer & maintainer review |
| **Webhook Ingestion** | Smee &rarr; `http://127.0.0.1:8787/api/github/webhook` | GitHub &rarr; `https://<byter-domain>.up.railway.app/api/github/webhook` | HMAC-SHA256 Signed POST | GitHub issue & comment event intake |
| **Persistence Journal** | `.data-local/` | Mounted Volume `/data/` | JSONL append-only | `webhook-runs.jsonl`, `approvals.jsonl` |

---

## Part 4: Troubleshooting & Edge Cases

### 1. TrueForge Startup Fails (`STANDALONE` Mode Mismatch)
- **Symptom:** TrueForge crashes on boot with errors regarding missing `POSTGRES_USER` or `REDIS_URL`.
- **Root Cause:** TrueForge defaults to distributed mode (`STANDALONE=false`) unless explicitly configured.
- **Fix:** In Railway Service 1 Variables, ensure `STANDALONE=true` is set. This directs TrueForge to use embedded SQLite (`/data/db/db.sqlite`) without requiring Postgres or Redis.

### 2. MCP Authentication Error (`401 MCP authentication required`)
- **Symptom:** TrueForge fails to list tools or execute MCP actions against Byter's `/mcp` endpoint.
- **Root Cause:** In TrueForge UI (`Settings → Connectors`), the `API key` field was populated with `<token>` instead of `Bearer <token>`. Byter's MCP server parses `Authorization.slice("Bearer ".length)` and rejects bare tokens.
- **Fix:** Update the connector's `API key` field in TrueForge UI to `Bearer <MCP_AUTH_TOKEN>`.

### 3. GitHub Webhook Returns `401 Unauthorized` / `Invalid signature`
- **Symptom:** GitHub webhook deliveries report `401` with body `{"error":"Invalid signature"}`.
- **Root Cause:** The secret configured in GitHub Repository Settings &rarr; Webhooks does not match `GITHUB_WEBHOOK_SECRET` in `.env` / Railway Variables.
- **Fix:** Ensure both values match character-for-character. Note that trailing spaces in environment variables will alter the HMAC digest.

### 4. Webhook Ignored ("Duplicate issue trigger suppressed")
- **Symptom:** Applying a label or editing an issue does not trigger a new Byter run.
- **Root Cause:** Byter enforces a 60-second duplicate trigger suppression window (`duplicateIssueTriggerWindowMs = 60_000`) for the same issue ID to prevent race conditions from concurrent GitHub webhook events.
- **Fix:** Wait 60 seconds before re-triggering, or edit the issue title to create a distinct trigger key.

### 5. Issue Comment Approval Returns `403 Forbidden`
- **Symptom:** Maintainer comments `approve` or `/byter approve` on GitHub, but Byter responds with an authorization error.
- **Root Cause:** Byter validates collaborator permissions via GitHub API (`getCollaboratorPermission`). The commenter must have `OWNER`, `admin`, `maintain`, or `write` permission on the repository.
- **Fix:** Ensure the comment is posted by an authorized repository collaborator, or approve via the Byter Dashboard UI using `APPROVAL_TOKEN`.

### 6. Security Scanner Rejection (`safeToExecute: false`)
- **Symptom:** Issue run transitions to `security-review` &rarr; `rejected` without starting TrueForge.
- **Root Cause:** The issue title or body triggered one of Byter's security heuristics (prompt injection markers, requests to dump `.env` or credentials, base64 payload strings, or forbidden shell invocations).
- **Fix:** Review the issue description. Remove suspicious commands or extraction phrases. Byter strictly blocks potential jailbreaks to protect the sandbox.

### 7. OpenAI API Quota or Model Errors
- **Symptom:** TrueForge reports `404 Model not found` or `429 Rate limit exceeded`.
- **Root Cause:** The configured OpenAI API key lacks quota or does not have access to `gpt-5.6-sol`.
- **Fix:** Verify your OpenAI API billing tier and quota. If needed, configure an alternative supported model such as `gpt-4o` in `.env` (`MODEL_NAME=gpt-4o`) and TrueForge UI.

### 8. Smee.io Webhook Forwarder Drops Connection Locally
- **Symptom:** Webhooks stop arriving at localhost during extended local development sessions.
- **Root Cause:** Public Smee channels can time out after network switches or sleep cycles.
- **Fix:** Restart the Smee daemon in Terminal 4: `npx smee -u https://smee.io/<channel_id> --target http://127.0.0.1:8787/api/github/webhook`.
