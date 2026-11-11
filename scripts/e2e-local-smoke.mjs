import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'veyra-e2e-'));
const port = Number(process.env.VEYRA_E2E_GATEWAY_PORT || 3114);
const browserOrigin = `http://localhost:${port - 4}`;

const gateway = spawn(process.execPath, ['src/index.js'], {
  cwd: join(root, 'apps/api-gateway'),
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'development',
    FRONTEND_URL: browserOrigin,
    VEYRA_DATABASE_PATH: join(temporaryDirectory, 'veyra.sqlite'),
    CALL_HISTORY_DIR: join(temporaryDirectory, 'legacy-calls'),
    RAG_SERVICE_URL: process.env.RAG_SERVICE_URL || 'http://localhost:8006',
    INGESTION_SERVICE_URL: process.env.INGESTION_SERVICE_URL || 'http://localhost:8002',
    REALTIME_AI_URL: process.env.REALTIME_AI_URL || 'http://localhost:8003',
    INSIGHTS_SERVICE_URL: process.env.INSIGHTS_SERVICE_URL || process.env.REALTIME_AI_URL || 'http://localhost:8003',
    AUTH_SESSION_SECRET: 'isolated-e2e-session-secret-with-at-least-32-characters',
    VOICE_SERVICE_TOKEN: 'isolated-e2e-provider-token-with-at-least-32-characters',
  },
  stdio: 'ignore',
});

let cookie = '';
const endpoint = `http://127.0.0.1:${port}`;

async function waitForGateway() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (gateway.exitCode !== null) throw new Error(`Isolated gateway exited with ${gateway.exitCode}`);
    try {
      const response = await fetch(`${endpoint}/api/auth/session`);
      if (response.ok) return;
    } catch {
      // The gateway is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  throw new Error('Isolated gateway did not become ready');
}

async function api(path, method = 'GET', body) {
  const response = await fetch(endpoint + path, {
    method,
    headers: {
      Origin: browserOrigin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

try {
  await waitForGateway();
  const setup = await api('/api/auth/setup', 'POST', {
    email: 'e2e@veyra.local', password: 'TemporaryE2E!2026', workspace: 'E2E verification',
  });

  const groundedId = 'full-flow-grounded';
  const created = await api('/api/voice/session', 'POST', {
    call_id: groundedId, market: 'india-loan', language: 'en-IN', channel: 'text',
  });
  const grounded = await api('/api/voice/query', 'POST', {
    call_id: groundedId, market: 'india-loan', query: 'What is the minimum age?', guided_mode: false,
  });
  const playbook = await api(`/api/voice/session/${groundedId}/playbook`);

  const guidedId = 'full-flow-guided';
  await api('/api/voice/session', 'POST', {
    call_id: guidedId, market: 'india-loan', language: 'en-IN', channel: 'text',
  });
  const guided = await api('/api/voice/query', 'POST', {
    call_id: guidedId, market: 'india-loan', query: 'What is the minimum age?', guided_mode: true,
  });
  const applied = await api(`/api/voice/session/${guidedId}/nudges/${guided.suggestion.id}/apply`, 'POST', {});

  const handoffId = 'full-flow-handoff';
  await api('/api/voice/session', 'POST', {
    call_id: handoffId, market: 'india-loan', language: 'en-IN', channel: 'text',
  });
  const handoffTurn = await api('/api/voice/query', 'POST', {
    call_id: handoffId, market: 'india-loan', query: 'I need to speak to a supervisor right now', guided_mode: false,
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1200));
  const nudges = await api(`/api/nudges?call_id=${handoffId}`);
  const handoffs = await api('/api/handoffs?state=open');

  const ended = await api(`/api/voice/session/${groundedId}/end`, 'POST', {});
  const summary = await api(`/api/voice/history/${groundedId}/summary`);
  const result = {
    authenticated_admin: setup.user?.role === 'admin',
    session_created: created.session?.status === 'created',
    grounded_response: grounded.response_kind === 'grounded' && grounded.sources?.length > 0,
    playbook_available: Boolean(playbook.playbook),
    guided_suggestion: guided.response_kind === 'guided_suggestion' && Boolean(guided.suggestion),
    guided_response_applied: applied.turn?.role === 'assistant',
    human_handoff: Boolean(handoffTurn.escalation) && handoffs.total >= 1,
    realtime_escalation_nudge: nudges.nudges?.some((nudge) => nudge.type === 'human_escalation') === true,
    call_archived: ended.status === 'ended',
    summary_generated: summary.latest?.generator === 'deterministic_fallback.v2',
  };
  if (Object.values(result).some((value) => !value)) throw new Error(`End-to-end check failed: ${JSON.stringify(result)}`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  if (gateway.exitCode === null) {
    gateway.kill('SIGTERM');
    await Promise.race([
      once(gateway, 'exit'),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 3000)),
    ]);
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}
