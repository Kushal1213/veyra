import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('operational controls and manual QA remain enforced, attributable, and content-free in aggregates', { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'veyra-qa-operations-'));
  const databasePath = join(directory, 'test.sqlite');
  let child;
  let base;

  async function stop() {
    if (child?.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }

  async function start() {
    const probe = createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    base = `http://127.0.0.1:${port}/api`;
    child = spawn(process.execPath, ['src/index.js'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      stdio: 'ignore',
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        VEYRA_DATABASE_PATH: databasePath,
        CALL_HISTORY_DIR: directory,
      },
    });
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Gateway exited: ${child.exitCode}`);
      try {
        if ((await fetch(`${base}/auth/session`)).ok) return;
      } catch {}
      await delay(50);
    }
    throw new Error('Gateway did not start');
  }

  async function api(path, { body, cookie = ownerCookie, method = body === undefined ? 'GET' : 'POST' } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        Cookie: cookie || '',
        Origin: 'http://localhost:3000',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const contentType = response.headers.get('content-type') || '';
    return {
      status: response.status,
      data: contentType.includes('json') ? await response.json() : await response.text(),
      cookie: response.headers.get('set-cookie')?.split(';')[0],
      headers: response.headers,
    };
  }

  async function invite(email, role, password) {
    const invited = await api('/team/invites', { body: { email, role } });
    assert.equal(invited.status, 201);
    const accepted = await api('/auth/accept-invite', {
      body: { token: invited.data.token, password },
      cookie: '',
    });
    assert.equal(accepted.status, 201);
    return accepted;
  }

  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });

  await start();
  let ownerCookie = '';
  const setup = await api('/auth/setup', {
    body: { email: 'owner@example.test', password: 'owner-password-2026', workspace: 'QA operations' },
    cookie: '',
  });
  assert.equal(setup.status, 201);
  ownerCookie = setup.cookie;
  const operator = await invite('operator@example.test', 'operator', 'operator-password-2026');
  const reviewer = await invite('reviewer@example.test', 'admin', 'reviewer-password-2026');

  await t.test('controls require admin mutations and enforce voice and ingestion pauses', async () => {
    assert.equal((await api('/operations/controls', { cookie: '' })).status, 401);
    const listed = await api('/operations/controls');
    assert.equal(listed.status, 200);
    assert.equal(listed.data.controls.length, 8);
    assert.equal(listed.data.controls.find((item) => item.key === 'outbound_delivery').available, false);
    assert.equal((await api('/operations/controls/new_sessions', {
      body: { enabled: false, reason: 'short' },
    })).status, 400);
    assert.equal((await api('/operations/controls/new_sessions', {
      body: { enabled: false, reason: 'Operator attempted to pause sessions.' },
      cookie: operator.cookie,
    })).status, 403);

    const pausedSessions = await api('/operations/controls/new_sessions', {
      body: { enabled: false, reason: 'Pause new sessions during a controlled release check.' },
    });
    assert.equal(pausedSessions.status, 200);
    assert.equal(pausedSessions.data.control.enabled, false);
    const rejectedSession = await api('/voice/session', { body: { call_id: 'paused-session' } });
    assert.equal(rejectedSession.status, 503);
    assert.equal(rejectedSession.data.code, 'CAPABILITY_PAUSED');
    assert.equal(rejectedSession.data.control.key, 'new_sessions');

    const events = await api('/operations/events?limit=5');
    assert.equal(events.status, 200);
    assert.equal(events.data.events[0].actor_email, 'owner@example.test');
    assert.equal(events.data.events[0].reason, 'Pause new sessions during a controlled release check.');
    assert.equal((await api('/operations/controls/new_sessions', {
      body: { enabled: true, reason: 'Resume new sessions after the controlled release check.' },
    })).status, 200);

    assert.equal((await api('/voice/session', { body: { call_id: 'qa-call' } })).status, 200);
    assert.equal((await api('/operations/controls/customer_answer_generation', {
      body: { enabled: false, reason: 'Pause generated answers while retrieval is investigated.' },
    })).status, 200);
    const pausedAnswer = await api('/voice/query', { body: { call_id: 'qa-call', query: 'What fees apply?' } });
    assert.equal(pausedAnswer.status, 200);
    assert.equal(pausedAnswer.data.response_kind, 'operational_pause');
    assert.equal(pausedAnswer.data.sources.length, 0);
    assert.equal((await api('/operations/controls/customer_answer_generation', {
      body: { enabled: true, reason: 'Resume generated answers after retrieval checks passed.' },
    })).status, 200);

    assert.equal((await api('/operations/controls/knowledge_ingestion', {
      body: { enabled: false, reason: 'Pause knowledge ingestion for a queue safety check.' },
    })).status, 200);
    const pausedUpload = await api('/knowledge/documents', {
      body: { title: 'Should not upload' },
    });
    assert.equal(pausedUpload.status, 503);
    assert.equal(pausedUpload.data.control.key, 'knowledge_ingestion');
    assert.equal((await api('/operations/controls/knowledge_ingestion', {
      body: { enabled: true, reason: 'Resume knowledge ingestion after the queue safety check.' },
    })).status, 200);
  });

  let rubric;
  let ownerReview;
  await t.test('QA rubric, sampling, draft replacement, completion, and coaching are durable', async () => {
    const greeting = await api('/voice/query', { body: { call_id: 'qa-call', query: 'Hello' } });
    assert.equal(greeting.status, 200);
    assert.equal((await api('/voice/session/qa-call/end', { body: {} })).status, 200);
    assert.equal((await api('/qa/rubrics', { cookie: operator.cookie })).status, 403);

    const created = await api('/qa/rubrics', {
      body: {
        name: 'Inbound loan support',
        version: '2026.1',
        description: 'Manual evidence-linked review for the controlled fixture.',
        criteria: [
          { label: 'Policy accuracy', description: 'The answer stays within approved policy.', weight: 2 },
          { label: 'Clear next step', description: 'The customer receives a clear next step.', weight: 1 },
        ],
      },
    });
    assert.equal(created.status, 201);
    rubric = created.data.rubric;
    assert.equal(rubric.status, 'draft');
    assert.equal((await api(`/qa/rubrics/${rubric.id}/activate`, { body: {} })).status, 200);

    const sample = await api('/qa/sample?days=7&review_state=unreviewed');
    assert.equal(sample.status, 200);
    assert.deepEqual(sample.data.calls.map((call) => call.call_id), ['qa-call']);
    assert.equal(JSON.stringify(sample.data).includes('Hello'), false);

    const started = await api('/qa/reviews', { body: { call_id: 'qa-call' } });
    assert.equal(started.status, 201);
    ownerReview = started.data.review;
    const [accuracy, nextStep] = rubric.criteria;
    assert.equal((await api(`/qa/reviews/${ownerReview.id}`, {
      method: 'PUT',
      body: { findings: [{ criterion_id: accuracy.id, verdict: 'pass', note: '', turn_index: 1, source_index: null }] },
    })).status, 200);
    const replacement = await api(`/qa/reviews/${ownerReview.id}`, {
      method: 'PUT',
      body: { findings: [{ criterion_id: nextStep.id, verdict: 'pass', note: '', turn_index: 1, source_index: null }] },
    });
    assert.equal(replacement.status, 200);
    assert.deepEqual(replacement.data.review.findings.map((item) => item.criterion_id), [nextStep.id]);
    assert.equal((await api(`/qa/reviews/${ownerReview.id}/complete`, { body: {} })).status, 409);

    assert.equal((await api(`/qa/reviews/${ownerReview.id}`, {
      method: 'PUT',
      body: { findings: [
        { criterion_id: accuracy.id, verdict: 'pass', note: '', turn_index: 1, source_index: null },
        { criterion_id: nextStep.id, verdict: 'fail', note: 'The next step was not specific enough.', turn_index: 1, source_index: null },
      ] },
    })).status, 200);
    const completed = await api(`/qa/reviews/${ownerReview.id}/complete`, { body: {} });
    assert.equal(completed.status, 200);
    assert.equal(completed.data.review.state, 'completed');
    assert.equal(completed.data.review.score_earned, 2);
    assert.equal(completed.data.review.score_possible, 3);
    assert.equal((await api(`/qa/reviews/${ownerReview.id}`, {
      method: 'PUT',
      body: { findings: [] },
    })).status, 409);
    const coached = await api(`/qa/reviews/${ownerReview.id}/coaching`, {
      body: { note: 'State one concrete next action before closing the call.' },
    });
    assert.equal(coached.status, 201);
    assert.equal(coached.data.review.coaching.length, 1);
  });

  await t.test('a second reviewer produces explicit agreement evidence and private aggregates', async () => {
    const second = await api('/qa/reviews', {
      body: { call_id: 'qa-call' },
      cookie: reviewer.cookie,
    });
    assert.equal(second.status, 201);
    assert.equal((await api(`/qa/reviews/${ownerReview.id}`, {
      method: 'PUT',
      body: { findings: [] },
      cookie: reviewer.cookie,
    })).status, 403);
    assert.equal((await api(`/qa/reviews/${second.data.review.id}`, {
      method: 'PUT',
      cookie: reviewer.cookie,
      body: { findings: rubric.criteria.map((criterion) => ({
        criterion_id: criterion.id,
        verdict: 'pass',
        note: '',
        turn_index: 1,
        source_index: null,
      })) },
    })).status, 200);
    assert.equal((await api(`/qa/reviews/${second.data.review.id}/complete`, {
      body: {},
      cookie: reviewer.cookie,
    })).status, 200);

    const bundle = await api('/qa/calls/qa-call');
    assert.equal(bundle.data.agreement.reviewer_pairs, 1);
    assert.equal(bundle.data.agreement.criterion_comparisons, 2);
    assert.equal(bundle.data.agreement.agreement_rate, 0.5);

    const report = await api('/qa/report?days=7');
    assert.equal(report.status, 200);
    assert.equal(report.data.sample_size, 2);
    assert.equal(report.data.reviewed_calls, 1);
    assert.equal(report.data.reviewer_count, 2);
    assert.equal(report.data.agreement_rate, 0.5);
    const csv = await api('/qa/report?days=7&format=csv');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-disposition'), /^attachment; filename="veyra-qa-/);
    assert.equal(csv.data.includes('Hello'), false);
    assert.equal(csv.data.includes('specific enough'), false);
    assert.equal(csv.data.includes('State one concrete'), false);
  });

  await t.test('call summaries are versioned, evidence-preserving, latest-only, and idempotently accepted', async () => {
    const generated = await api('/voice/history/qa-call/summary');
    assert.equal(generated.status, 200);
    assert.equal(generated.data.latest.version, 1);
    assert.equal(generated.data.latest.generator, 'deterministic_fallback.v2');
    assert.equal(generated.data.latest.state, 'draft');
    assert.ok(generated.data.latest.sections.some((section) => section.id === 'conversation_quality'));
    assert.ok(generated.data.latest.sections.some((section) =>
      section.items.some((item) => item.evidence.some((entry) => entry.kind === 'turn'))));

    const repeated = await api('/voice/history/qa-call/summary');
    assert.equal(repeated.data.versions.length, 1);
    assert.equal(repeated.data.latest.id, generated.data.latest.id);

    const revised = await api(`/voice/history/qa-call/summary/${generated.data.latest.id}/revise`, {
      body: {
        sections: { next_actions: 'Confirm the customer has no further questions.\nClose the interaction.' },
        follow_up_actions: ['Send the approved fee schedule.'],
      },
    });
    assert.equal(revised.status, 201);
    assert.equal(revised.data.summary.version, 2);
    assert.equal(revised.data.summary.generator, 'operator_edit');
    assert.equal(revised.data.summary.parent_summary_id, generated.data.latest.id);
    assert.equal(revised.data.summary.sections.find((section) => section.id === 'next_actions').items.length, 2);
    assert.equal(revised.data.summary.follow_up_actions[0].created_source, 'operator_edit');
    assert.equal((await api(`/voice/history/qa-call/summary/${generated.data.latest.id}/accept`, { body: {} })).status, 409);

    const accepted = await api(`/voice/history/qa-call/summary/${revised.data.summary.id}/accept`, { body: {} });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.data.summary.state, 'accepted');
    const replay = await api(`/voice/history/qa-call/summary/${revised.data.summary.id}/accept`, { body: {} });
    assert.equal(replay.status, 200);
    assert.equal(replay.data.summary.accepted_at, accepted.data.summary.accepted_at);

    const history = await api('/voice/history/qa-call/summary');
    assert.deepEqual(history.data.versions.map((summary) => summary.version), [2, 1]);
  });

  await t.test('disclosure checklists enforce source governance, separation of duties, shadow evaluation, and append-only decisions', async () => {
    const database = new DatabaseSync(databasePath);
    try {
      const document = {
        id: 'published-policy-v1',
        workspaceId: 'default',
        title: 'Published lending policy',
        filename: 'published-lending-policy.txt',
        revision: 1,
        status: 'indexed',
        publicationStatus: 'published',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
      };
      database.prepare('INSERT INTO knowledge_documents (id, workspace_id, filename, content, payload) VALUES (?, ?, ?, ?, ?)')
        .run(document.id, 'default', document.filename, Buffer.from('Approved annual percentage rate disclosure.'), JSON.stringify(document));
    } finally {
      database.close();
    }

    const definition = {
      title: 'India loan disclosure shadow check',
      version: '2026.1',
      market: 'india-loan',
      channel: 'text',
      workflow: 'loan_information',
      effective_from: '2026-01-01',
      effective_to: null,
      owner_note: 'Shadow-mode workflow aid for release verification.',
      items: [{
        id: 'apr-mentioned',
        label: 'APR wording mentioned',
        description: 'Confirm that the customer or operator mentioned the configured wording.',
        applicability: 'required',
        condition_note: '',
        roles: ['user'],
        phrases: ['hello'],
        require_sources: false,
        source_refs: [{ document_id: 'published-policy-v1', revision: 1 }],
        human_confirmation_required: true,
      }],
    };
    const created = await api('/disclosure-checklists', { body: definition });
    assert.equal(created.status, 201);
    assert.equal(created.data.checklist.status, 'draft');
    assert.equal((await api(`/disclosure-checklists/${created.data.checklist.id}/approve`, { body: {} })).status, 409);
    const operatorList = await api('/disclosure-checklists', { cookie: operator.cookie });
    assert.equal(operatorList.status, 200);
    assert.equal(operatorList.data.checklists.length, 0);

    const approved = await api(`/disclosure-checklists/${created.data.checklist.id}/approve`, {
      body: {}, cookie: reviewer.cookie,
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.data.checklist.effective_status, 'active');
    assert.equal((await api('/disclosure-checklists', { cookie: operator.cookie })).data.checklists.length, 1);

    const overlap = await api('/disclosure-checklists', { body: { ...definition, version: '2026.2' } });
    assert.equal(overlap.status, 201);
    assert.equal((await api(`/disclosure-checklists/${overlap.data.checklist.id}/approve`, {
      body: {}, cookie: reviewer.cookie,
    })).status, 409);

    assert.equal((await api('/voice/session', { body: { call_id: 'disclosure-call', channel: 'text' } })).status, 200);
    assert.equal((await api('/voice/query', {
      body: { call_id: 'disclosure-call', query: 'Hello' },
    })).status, 200);
    const evaluated = await api('/voice/session/disclosure-call/disclosure-checklist');
    assert.equal(evaluated.status, 200);
    assert.equal(evaluated.data.checklist.mode, 'shadow');
    assert.equal(evaluated.data.checklist.items[0].suggested_state, 'observed');
    assert.equal(evaluated.data.checklist.items[0].evidence.role, 'user');
    assert.equal(evaluated.data.checklist.items[0].confirmed, false);
    assert.equal((await api('/voice/session/disclosure-call/disclosure-checklist/items/apr-mentioned/confirm', {
      body: { decision: 'missing', note: '' },
    })).status, 400);
    assert.equal((await api('/voice/session/disclosure-call/disclosure-checklist/items/apr-mentioned/confirm', {
      body: { decision: 'observed', note: '' },
    })).status, 200);
    const updated = await api('/voice/session/disclosure-call/disclosure-checklist/items/apr-mentioned/confirm', {
      body: { decision: 'not_applicable', note: 'Customer changed the requested product.' },
      cookie: operator.cookie,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.checklist.items[0].state, 'not_applicable');

    const eventDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const events = eventDatabase.prepare(`SELECT payload FROM disclosure_confirmation_events
        ORDER BY id`).all().map((row) => JSON.parse(row.payload));
      assert.equal(events.length, 2);
      assert.equal(events[1].previous_decision, 'observed');
      assert.equal(events[1].decision, 'not_applicable');
    } finally {
      eventDatabase.close();
    }
  });
});
