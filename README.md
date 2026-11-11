# Veyra

Veyra is a knowledge-grounded voice intelligence platform for customer conversations. It combines live voice interaction, retrieval-augmented answers, source citations, real-time conversation signals, and localized agents in one operational workspace.

## What Veyra Does

- Runs browser-based voice conversations with live transcription and spoken responses.
- Grounds answers in an indexed knowledge base and displays supporting citations.
- Detects conversation signals such as customer frustration, compliance risk, buying intent, and escalation requests.
- Streams transcripts and insights to a live mission-control view.
- Supports localized agents for India, the Philippines, and Indonesia.
- Provides knowledge, analytics, architecture, and service-health views for operators.
- Delivers explicit human-assistance requests to a durable internal inbox with acknowledgement, resolution, and audit history.
- Groups repeated retrieval abstentions into a knowledge-owner triage inbox.
- Produces versioned, evidence-linked after-call summary drafts with operator revision and acceptance history.
- Supports customer-authored disclosure checklists in advisory shadow mode with effective dates, published-source binding, and human confirmation.
- Provides audited operational pause controls and manual, evidence-linked QA/coaching workflows.

## Product Areas

| Area | Purpose |
|---|---|
| Dashboard | Operational overview and service status |
| Voice Studio | Live customer-agent conversations with RAG citations |
| Live Insights | Transcript monitoring, signal detection, and agent nudges |
| Call History | Completed conversations, source citations, handoff review, and evidence-linked summary approval |
| Handoff Inbox | Delivered, acknowledged, and resolved human-assistance work |
| Knowledge Hub | Controlled publication, grounding visibility, knowledge-gap triage, and disclosure-checklist governance |
| Analytics | Conversation and retrieval performance views |
| QA & Coaching | Deterministic call sampling, immutable rubrics, evidence-linked manual review, and coaching history |
| Operations | Audited capability controls and degraded-state visibility |
| Architecture | Runtime topology and service relationships |

Veyra currently includes four market agents:

| Agent | Market | Language |
|---|---|---|
| Aria | India loans | English (`en-IN`) |
| Priya | India insurance | English (`en-IN`) |
| Maria | Philippines bancassurance | English/Taglish (`en-PH`) |
| Dewi | Indonesia consumer finance | Bahasa Indonesia (`id`) |

## Architecture

```text
Browser (React + Vite, :3000)
            |
            v
Express API Gateway + Socket.IO (:3001)
       |              |               |
       v              v               v
RAG Service      Ingestion       Realtime Insights
(FastAPI, :8001) (FastAPI, :8002) (FastAPI, :8003)
       |              |
       +------ Knowledge Base ------+
```

The frontend talks to the gateway through Vite's local proxy. The gateway coordinates voice turns, RAG requests, transcript events, CRM actions, and service health. Python services handle retrieval, document ingestion, and realtime signal analysis.

## Technology

- React 18, Vite, Tailwind CSS, Framer Motion, and Recharts
- Express, Socket.IO, and Node.js
- FastAPI, FAISS, and Google Gemini
- Browser Web Speech APIs and optional Vapi integration
- Local document ingestion for PDF and text sources

## Getting Started

### Requirements

- Node.js 22.13 or newer (gateway uses built-in SQLite)
- Python 3.10 or newer
- Chrome or Edge for browser microphone and speech-recognition support
- A Gemini API key for live model-backed responses

### Install

```powershell
git clone https://github.com/Kushal1213/darwinxvapi.git
cd darwinxvapi

npm install
python -m pip install -r services/requirements.txt
Copy-Item .env.example .env
```

Set at least the following value in `.env`:

```env
GEMINI_API_KEY=your_gemini_api_key
```

The default local service URLs and ports in `.env.example` work with the included startup scripts. The local demo uses the browser Web Speech API and its text fallback; it does not need Vapi or a public webhook. Vapi and Deepgram credentials are optional unless those providers are used. Vapi additionally requires a public HTTPS `PUBLIC_WEBHOOK_URL`; Veyra refuses to configure it without that callback so provider calls cannot bypass grounded retrieval, handoff, or audit controls.

For a real Vapi deployment, set `VOICE_SERVICE_TOKEN` to a random value of at least 32 characters, then create two Vapi credentials that use that token: a **Server Configuration** bearer credential and a **Custom LLM** API-key credential. Put their IDs in `VAPI_SERVER_CREDENTIAL_ID` and `VAPI_CUSTOM_LLM_CREDENTIAL_ID`. The saved assistant is configured with the current `server` object and those credential IDs; it never saves an unauthenticated callback.

### Run

Start the complete local stack from the repository root:

```powershell
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The command starts the frontend, API gateway, RAG service, ingestion service, and realtime-insights service together. Press `Ctrl+C` to stop them.

With the local stack running, use `npm run test:e2e:local` for a disposable
end-to-end check. It uses the live local RAG and realtime-insights services but
creates its own temporary workspace, database, calls, and sessions.

To run services independently:

```powershell
npm run dev:frontend
npm run dev:gateway
npm run dev:rag
npm run dev:ingestion
npm run dev:realtime
```

## Using Voice Studio

On first launch, create the local workspace and owner account. Subsequent visits
require sign-in. Passwords must have at least 12 characters; no default account or
password is provided. The account protects gateway APIs and live socket events.
See [workspace access](docs/WORKSPACE_ACCESS.md) for configuration and boundaries.

For a separate tenant stack, run `npm run tenant -- init <tenant-id> <base-port>`
and `npm run tenant -- start <tenant-id>`. Each tenant has separate storage,
credentials, services, and browser sessions. This is a local dedicated-stack
workflow, not shared-process multi-tenancy or production hosting.
See [tenant provisioning](docs/TENANT_STACKS.md) for setup and security limits.

1. Open **Voice Studio**.
2. Select a market agent.
3. Start a voice call and allow microphone access.
4. Ask a question covered by the knowledge base.
5. Review the live transcript, grounded response, and source citation.

Example: `What is the minimum income required for a personal loan?`

The experience degrades gracefully when an external voice provider is unavailable. Browser speech and server-side fallback paths remain available for local development.

## Live Insights

Live Insights receives transcript events from the gateway and displays conversation telemetry, detected signals, recommended actions, and escalation state. Built-in scenarios can be used to exercise the signal pipeline without placing a real call.

Operator nudges persist across refreshes and gateway restarts. Acknowledge or
dismiss active alerts, and record usefulness feedback in Mission Control or Call
Review. See [operator nudge rules](docs/NUDGE_WORKFLOW.md) for expiry, priority,
duplicate suppression, and the feedback API.

Voice Studio replies automatically by default. For conversations that require human
review, enable **Require approval before replying**. Grounded product answers then pause
as cited live tips until an operator selects **Use this reply**; the approved answer is
recorded as the next assistant turn and spoken during a voice call. A newer product
question replaces an unselected older tip without displacing compliance or escalation
alerts.

During an open session, **Ask Veyra privately** lets an operator search approved
knowledge without adding the question to the customer transcript. The resulting cited
reply can be reviewed, edited, copied, and explicitly spoken or added to text chat.
Veyra preserves the generated and delivered wording with operator attribution.

The India loan demo also exposes a versioned **Live playbook**. It derives observed
steps from persisted transcript evidence, requires citations before knowledge-delivery
steps count as observed, and recommends either a customer question or a private
knowledge search. It is a workflow guide, not a lending or compliance decision. See
[live playbooks](docs/LIVE_PLAYBOOKS.md) for the contract and current limits.

Knowledge Hub administrators can author disclosure-checklist versions supplied by a
customer policy owner, bind every topic to published knowledge, and obtain approval
from a different administrator. Matching calls display conservative advisory states
and attributed human confirmations in Voice Studio. Veyra bundles no legal checklist;
see [disclosure shadow mode](docs/DISCLOSURE_CHECKLISTS.md) for its safeguards.

Operational Analytics includes a grounded-guidance funnel with apply/edit/dismiss
rates, reason-coded rejection, source presence, operator feedback response, generation
and decision latency, origin, and handoff context. These are interaction metrics—not
claims of answer correctness, compliance, customer satisfaction, or ROI.

## Call Review

End a voice call or select **End Session** after a text conversation, then open
**Call History** to review the transcript, citations, and any human handoff request.
Call Review also prepares a clearly labelled deterministic summary draft. Each factual
item links to a transcript turn or saved knowledge citation; operators can create an
immutable revision and explicitly accept the latest draft. Proposed follow-up actions
are review items, not proof that an external task or customer contact occurred. See
[after-call summaries](docs/CALL_SUMMARIES.md) for the lifecycle and limits.
Explicit requests are atomically delivered to **Handoff Inbox**, where an operator
can acknowledge and resolve them after the call ends. Internal inbox delivery is
not presented as a completed phone transfer or external-provider acknowledgement.
Active and completed calls persist in SQLite across gateway restarts. Set
`VEYRA_DATABASE_PATH` to override `data/veyra.sqlite`. Existing JSON archives in
`data/calls/` (or `CALL_HISTORY_DIR`) are imported once without deleting originals.
The installation supports one workspace with admin and operator accounts.

See [the session contract](docs/CALL_SESSION_CONTRACT.md) for lifecycle rules,
API endpoints, and current limitations.

## Operational Analytics

Dashboard and Analytics now read persisted workspace calls. Filter Analytics by
7, 30, or 90 UTC days and agent/market, inspect call volume, handoff requests,
session duration, recorded reply latency, and citation coverage, or export daily
counts as CSV. Missing measurements appear as unavailable rather than sample data.
Dashboard includes service health and direct links to individual call reviews;
review URLs can be bookmarked and support browser Back/Forward.

See [analytics definitions](docs/ANALYTICS.md) for cohort boundaries, sample counts,
and limitations. Citation presence is not a measure of answer correctness.

## QA and Release Operations

Administrators can create immutable manual QA rubric versions, activate one version,
sample completed calls deterministically, attach findings to transcript or citation
evidence, complete reviews, add coaching notes, and compare reviewer agreement. Aggregate
CSV exports exclude transcript, finding-note, and coaching content. No AI score or bundled
customer rubric is represented. See [QA reviews](docs/QA_REVIEWS.md).

The Operations page exposes durable pause controls for new sessions, answer generation,
private guidance, guided delivery, proactive nudges, knowledge ingestion, and publication.
Every state change requires a reason and is attributed in an audit trail. Outbound delivery
remains explicitly unavailable until a customer selects and configures a connector.
Backup, restore, provider-disable, incident, and decommission procedures are documented in
the [operations runbook](docs/OPERATIONS_RUNBOOK.md).

## Use Cases and Next Releases

The first local slices of delivered human handoff, knowledge-gap triage, evidence-linked
summaries, and customer-owned disclosure shadow mode are implemented. The prioritized
product plan also covers external handoff connectors, QA review, knowledge change impact,
and operational kill switches. See the
[use-case implementation plan](docs/USE_CASE_IMPLEMENTATION_PLAN.md) for dependencies,
acceptance criteria, estimates, and release sequencing. See the
[release status](docs/RELEASE_STATUS.md) for the boundary between verified local
capabilities and external launch prerequisites.

## Grounding Evaluation

The repository includes a provider-free grounding evaluation starter suite. It
checks fixture cases for answerable questions, wrong market/product requests,
unpublished draft content, and unsupported questions, then writes a JSON report
with pass/fail denominators, retrieval mode, sources, and abstention reasons.

Run it from the repository root:

```powershell
$env:PYTHONPATH = 'services'
python services/grounding_eval.py --output evaluation/grounding_report.json
```

See [grounding evaluation](docs/GROUNDING_EVALUATION.md) for manifest fields and
limits. Passing the fixture suite is not a production accuracy claim.

## Provider Readiness

Generate a local provider and dependency inventory without printing secrets:

```powershell
npm run readiness:providers
```

Use `-- --audit` to include an `npm audit --json` summary, or
`-- --output evaluation/provider_inventory.json` to write a review artifact.
See [provider readiness](docs/PROVIDER_READINESS.md) for report fields and
current expected findings.

## Configuration

Important environment variables are documented in `.env.example`.

| Variable | Purpose | Default |
|---|---|---|
| `GEMINI_API_KEY` | Gemini generation access | Required for live Gemini responses |
| `GEMINI_MODEL` | Generation model | `gemini-2.5-flash` |
| `PORT` | API gateway port | `3004` |
| `RAG_SERVICE_URL` | RAG service address | `http://localhost:8006` |
| `INGESTION_SERVICE_URL` | Ingestion service address | `http://localhost:8002` |
| `REALTIME_AI_URL` | Realtime-insights address | `http://localhost:8003` |
| `VAPI_API_KEY` | Optional Vapi integration | Unset |
| `VITE_VAPI_PUBLIC_KEY` | Optional public Vapi browser identifier; never a secret | Unset |
| `PUBLIC_WEBHOOK_URL` | Required public HTTPS callback base for grounded Vapi calls | Unset |
| `VOICE_SERVICE_TOKEN` | Server-only callback token; required for real Vapi calls | Unset |
| `VAPI_SERVER_CREDENTIAL_ID` | Vapi Server Configuration credential ID | Unset |
| `VAPI_CUSTOM_LLM_CREDENTIAL_ID` | Vapi Custom LLM credential ID | Unset |
| `DEEPGRAM_API_KEY` | Optional Deepgram integration | Unset |

Never commit `.env` or provider credentials.

## API Overview

### Gateway

```text
GET  /api/health
POST /api/voice/query
POST /api/rag/query
GET  /api/handoffs
POST /api/handoffs/:id/acknowledge
POST /api/handoffs/:id/resolve
GET  /api/knowledge/gaps
GET  /api/operations/controls
POST /api/operations/controls/:key
GET  /api/qa/sample
POST /api/qa/rubrics
POST /api/qa/reviews
```

### RAG service

```text
GET  /health
POST /retrieve
```

### Ingestion service

```text
GET  /health
POST /ingest/pdf
POST /ingest/url
POST /ingest/text
```

Interactive FastAPI documentation is available at `/docs` on each Python service while it is running.

## Repository Layout

```text
apps/
  frontend/              React application
  api-gateway/           Express and Socket.IO gateway
services/
  rag-service/           Retrieval and grounded response generation
  ingestion-service/     Document parsing and indexing
  realtime-insights/     Signal detection and live recommendations
knowledge-base/
  raw/                   Source documents
  embeddings/            Local index and metadata
scripts/                 Cross-platform local startup helpers
shared/                  Shared schemas and utilities
```

## Verification

Run the complete provider-free release gate before opening a pull request:

```powershell
npm run verify
```

This runs frontend behavior, gateway, Python, tenant-isolation, provider-inventory,
grounding, frontend-build, and dependency-audit checks. It does not contact paid model
or voice providers.

Check the running stack through:

```text
http://localhost:3001/api/health
```

The health endpoint requires a signed-in session. It reports each service
separately and returns a degraded status when an optional dependency is unavailable.

Individual checks remain available through the `test:*`, `build`, and `audit:*` scripts.

## License

MIT
