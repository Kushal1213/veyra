import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { io as connectSocket } from 'socket.io-client';

test('voice sessions, handoff, archive and restart', { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'veyra-history-test-'));
  let requests = 0;
  const retrieveBodies = [];
  let releaseSlow;
  let signalSlow;
  const slowStarted = new Promise((resolve) => { signalSlow = resolve; });
  const mock = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || '{}');
    const { query, text } = parsed;
    if (req.url !== '/retrieve') {
      res.setHeader('Content-Type', 'application/json');
      const nudges = text === 'nudge-trigger'
        ? [{ signal_type: 'buying_signal', text: 'Offer next steps.', priority: 'LOW', confidence: 0.8 }]
        : text === 'I need to speak to a supervisor right now'
          ? [{ signal_type: 'human_escalation', text: 'Prepare the handoff.', priority: 'HIGH', confidence: 0.9 }]
          : [];
      res.end(JSON.stringify({ nudges }));
      return;
    }
    requests += 1;
    retrieveBodies.push(parsed);
    if (query === 'invalid-scope') {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Invalid market' }));
      return;
    }
    if (query === 'slow') {
      signalSlow();
      await new Promise((resolve) => { releaseSlow = resolve; });
    }
    res.setHeader('Content-Type', 'application/json');
    if (query === 'unsupported-with-source') {
      res.end(JSON.stringify({ answer: 'I could not support this from approved knowledge.', abstention_reason: 'insufficient_support', sources: [
        { source: 'loan-policy', title: 'Loan policy', chunk_id: 'candidate-1', excerpt: 'Candidate but insufficient.', score: 0.4 },
      ] }));
      return;
    }
    res.end(JSON.stringify({ answer: 'Policy answer', sources: query === 'unknown' ? [] : [
      { source: 'loan-policy', title: 'Loan policy', page: 7, chunk_id: 'income-1', excerpt: 'Approved income requirements.', score: 0.8 },
    ] }));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  let child;
  let base;
  let cookie = '';
  let reviewDeliveryId;
  let knowledgeGapId;
  async function start() {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    base = `http://127.0.0.1:${port}/api/voice`;
    child = spawn(process.execPath, ['src/index.js'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, NODE_ENV: 'test', PORT: String(port), CALL_HISTORY_DIR: directory, VEYRA_DATABASE_PATH: join(directory, 'test.sqlite'),
        VOICE_SERVICE_TOKEN: 'test-provider-token-with-at-least-32-characters',
        RAG_SERVICE_URL: `http://127.0.0.1:${mock.address().port}`,
        INSIGHTS_SERVICE_URL: `http://127.0.0.1:${mock.address().port}`, VAPI_API_KEY: '', PUBLIC_WEBHOOK_URL: '', LOG_LEVEL: 'silent' },
      stdio: 'ignore',
    });
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Gateway exited: ${child.exitCode}`);
      try { if ((await fetch(`${base}/live`)).status === 401) return; } catch { /* Wait for listen. */ }
      await delay(50);
    }
    throw new Error('Gateway did not start');
  }
  async function stop() {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
  async function api(path, body) {
    const response = await fetch(`${base}${path}`, {
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'http://localhost:3000' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  }
  t.after(async () => {
    releaseSlow?.();
    await stop();
    mock.closeAllConnections();
    await new Promise((resolve) => mock.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await start();
  const owner = { email: 'owner@example.test', password: 'test-password-for-veyra', workspace: 'Test Workspace' };
  const setup = await fetch(base.replace('/voice', '/auth/setup'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' }, body: JSON.stringify(owner),
  });
  assert.equal(setup.status, 201);
  cookie = setup.headers.get('set-cookie').split(';')[0];

  await t.test('retrieval aliases preserve product filters and reject malformed queries', async () => {
    const retrieve = (path, body) => fetch(base.replace('/voice', '/rag') + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'http://localhost:3000' }, body: JSON.stringify(body),
    });
    for (const path of ['/query', '/retrieve']) {
      assert.equal((await retrieve(path, { query: '  grace period  ', product: 'life-insurance', market: 'india', top_k: 1 })).status, 200);
      assert.equal(retrieveBodies.at(-1).product, 'life-insurance');
      assert.equal(retrieveBodies.at(-1).query, 'grace period');
      const before = requests;
      for (const body of [{ query: ' ' }, { query: 'x', top_k: 99 }, { query: 'x', product: '' }, { query: 'x'.repeat(4001) }]) {
        assert.equal((await retrieve(path, body)).status, 400);
      }
      assert.equal(requests, before);
      assert.equal((await retrieve(path, { query: 'invalid-scope' })).status, 422);
    }
  });

  await t.test('creation is idempotent and retains grounded turns', async () => {
    const created = await api('/session', { call_id: 'review-call' });
    assert.equal(created.data.session.status, 'created');
    const turn = await api('/query', { call_id: 'review-call', query: 'loan income' });
    assert.equal(turn.data.session.status, 'active');
    assert.equal(turn.data.session.state.confidence, null);
    assert.equal(turn.data.sources[0].chunk_id, 'income-1');
    assert.equal(turn.data.sources[0].page, 7);
    assert.deepEqual(turn.data.session.turns.map((entry) => entry.sequence), [1, 2]);
    assert.ok(turn.data.session.turns.every((entry) => Number.isInteger(entry.elapsed_ms) && entry.elapsed_ms >= 0));
    assert.equal(retrieveBodies.at(-1).market, 'india');
    assert.equal(retrieveBodies.at(-1).product, 'loan');
    const playbook = await api('/session/review-call/playbook');
    assert.equal(playbook.status, 200);
    assert.equal(playbook.data.playbook.id, 'india-loan-information');
    assert.equal(playbook.data.playbook.version, '2026-10-06.1');
    assert.equal(playbook.data.playbook.detected_intent, 'loan_inquiry');
    assert.ok(playbook.data.playbook.observed_steps >= 1);
    assert.ok(playbook.data.playbook.next_step.action.text);
    const repeated = await api('/session', { call_id: 'review-call' });
    assert.equal(repeated.data.session.turns.length, 2);
  });

  await t.test('Vapi fails closed rather than falling back to an ungrounded model', async () => {
    const config = await api('/../vapi/assistant-config?market=india-loan');
    assert.equal(config.status, 503);
    assert.equal(config.data.code, 'VAPI_WEBHOOK_UNAVAILABLE');
    assert.match(config.data.error, /publicly reachable HTTPS/i);
  });

  await t.test('after-call summaries flag only observable clarification recovery signals', async () => {
    assert.equal((await api('/query', { call_id: 'recovery-call', query: 'Could you repeat that? I am confused.' })).status, 200);
    assert.equal((await api('/session/recovery-call/end', {})).status, 200);
    const summary = await api('/history/recovery-call/summary');
    assert.equal(summary.status, 200);
    assert.equal(summary.data.latest.generator, 'deterministic_fallback.v2');
    const recovery = summary.data.latest.sections.find((section) => section.id === 'conversation_quality');
    assert.equal(recovery.items.length, 1);
    assert.match(recovery.items[0].text, /without an explicit acknowledgement or clarification cue/i);
    assert.deepEqual(recovery.items[0].evidence.map((entry) => entry.turn_index), [0, 1]);
  });

  await t.test('voice market IDs are scoped before retrieval', async () => {
    const insurance = await api('/query', { call_id: 'insurance-scope', market: 'india-insurance', query: 'grace period' });
    assert.equal(insurance.status, 200);
    assert.equal(insurance.data.session.market, 'india-insurance');
    assert.equal(retrieveBodies.at(-1).market, 'india');
    assert.equal(retrieveBodies.at(-1).product, 'insurance');
    assert.equal((await api('/session/insurance-scope/playbook')).data.playbook, null);
    assert.equal((await api('/session', { call_id: 'bad-market', market: 'mars' })).status, 400);
    await api('/session/insurance-scope/end', {});
  });

  await t.test('guided mode pauses a grounded answer until an operator applies its tip', async () => {
    assert.equal((await api('/query', { call_id: 'guided-invalid', query: 'loan income', guided_mode: 'yes' })).status, 400);
    const suggestion = await api('/query', { call_id: 'guided-call', query: 'loan income', guided_mode: true });
    assert.equal(suggestion.status, 200);
    assert.equal(suggestion.data.answer, null);
    assert.equal(suggestion.data.response_kind, 'guided_suggestion');
    assert.equal(suggestion.data.session.turns.length, 1);
    assert.equal(suggestion.data.suggestion.type, 'knowledge_tip');
    assert.equal(suggestion.data.suggestion.suggested_response, 'Policy answer');
    assert.equal(suggestion.data.suggestion.sources[0].page, 7);
    const applied = await api(`/session/guided-call/nudges/${suggestion.data.suggestion.id}/apply`, {});
    assert.equal(applied.status, 200);
    assert.equal(applied.data.answer, 'Policy answer');
    assert.equal(applied.data.nudge.status, 'applied');
    assert.equal(applied.data.turn.guided_by_nudge_id, suggestion.data.suggestion.id);
    assert.equal(applied.data.turn.sources[0].page, 7);
    const replayed = await api(`/session/guided-call/nudges/${suggestion.data.suggestion.id}/apply`, {});
    assert.equal(replayed.data.replayed, true);
    assert.equal((await api('/session/guided-call')).data.turns.length, 2);
    const events = await api(`/../nudges/${suggestion.data.suggestion.id}/events`);
    assert.deepEqual(events.data.events.map((event) => event.action), ['created', 'applied']);
    assert.ok(events.data.events[1].actor_id);
    const beforePrivateTurns = (await api('/session/guided-call')).data.turns.length;
    const privateSuggestion = await api('/session/guided-call/guidance/query', { query: 'What should I say about prepayment?' });
    assert.equal(privateSuggestion.status, 200);
    assert.equal(privateSuggestion.data.response_kind, 'guided_suggestion');
    assert.equal(privateSuggestion.data.suggestion.origin, 'operator_query');
    assert.ok(privateSuggestion.data.suggestion.requested_by);
    assert.equal((await api('/session/guided-call')).data.turns.length, beforePrivateTurns);
    const edited = await api(`/session/guided-call/nudges/${privateSuggestion.data.suggestion.id}/apply`, {
      response_text: 'Here is the reviewed prepayment information from our approved policy.',
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.answer, 'Here is the reviewed prepayment information from our approved policy.');
    assert.equal(edited.data.nudge.suggested_response, 'Policy answer');
    assert.equal(edited.data.nudge.was_edited, true);
    assert.equal(edited.data.turn.guided_was_edited, true);
    assert.equal(edited.data.turn.guided_original_response, 'Policy answer');
    const editedReplay = await api(`/session/guided-call/nudges/${privateSuggestion.data.suggestion.id}/apply`, {
      response_text: 'This must not replace the first delivered wording.',
    });
    assert.equal(editedReplay.data.answer, edited.data.answer);
    assert.equal(editedReplay.data.replayed, true);
    assert.equal((await api('/session/guided-call/guidance/query', { query: '' })).status, 400);
    const turnsBeforePrivateAbstention = (await api('/session/guided-call')).data.turns.length;
    const privateAbstention = await api('/session/guided-call/guidance/query', { query: 'unknown' });
    assert.equal(privateAbstention.data.response_kind, 'guidance_abstention');
    assert.equal(privateAbstention.data.suggestion, null);
    assert.equal((await api('/session/guided-call')).data.turns.length, turnsBeforePrivateAbstention);
    const nextSuggestion = await api('/query', { call_id: 'guided-call', query: 'loan amount', guided_mode: true });
    assert.equal(nextSuggestion.data.response_kind, 'guided_suggestion');
    assert.notEqual(nextSuggestion.data.suggestion.id, suggestion.data.suggestion.id);
    assert.equal(nextSuggestion.data.suggestion.status, 'created');
    assert.equal((await api(`/session/guided-call/nudges/${nextSuggestion.data.suggestion.id}/apply`, { response_text: ' ' })).status, 400);
    const handoff = await api('/query', { call_id: 'guided-call', query: 'I need a human', guided_mode: true });
    assert.equal(handoff.data.session.status, 'escalated');
    assert.equal((await api(`/session/guided-call/nudges/${nextSuggestion.data.suggestion.id}/apply`, {})).status, 409);
    assert.equal((await api('/session/guided-call/guidance/query', { query: 'Can the bot continue?' })).status, 409);
    await api('/session/guided-call/end', {});
  });

  await t.test('human handoff skips retrieval and includes context', async () => {
    const before = requests;
    const turn = await api('/query', { call_id: 'review-call', query: 'I want to talk to a human' });
    assert.equal(turn.status, 200);
    assert.equal(requests, before);
    assert.equal(turn.data.session.status, 'escalated');
    assert.equal(turn.data.escalation.sources[0].source, 'loan-policy');
    assert.equal(turn.data.escalation.last_customer_message, 'I want to talk to a human');
    assert.equal((await api('/session/review-call/playbook')).data.playbook.paused_for_handoff, true);
    const repeated = await api('/escalate', { call_id: 'review-call' });
    assert.equal(repeated.data.escalation_id, turn.data.escalation.escalation_id);
    const inbox = await api('/../handoffs?state=open');
    assert.equal(inbox.status, 200);
    assert.equal(inbox.data.total, 2);
    const reviewDelivery = inbox.data.handoffs.find((item) => item.call_id === 'review-call');
    assert.ok(reviewDelivery);
    assert.equal(reviewDelivery.escalation_id, turn.data.escalation.escalation_id);
    assert.equal(reviewDelivery.state, 'delivered');
    reviewDeliveryId = reviewDelivery.id;
    const detail = await api(`/../handoffs/${reviewDeliveryId}`);
    assert.deepEqual(detail.data.events.map((event) => event.action), ['requested', 'delivered']);
    const acknowledged = await api(`/../handoffs/${reviewDeliveryId}/acknowledge`, {});
    assert.equal(acknowledged.data.state, 'acknowledged');
    assert.ok(acknowledged.data.events.at(-1).actor_id);
    assert.equal((await api(`/../handoffs/${reviewDeliveryId}/acknowledge`, {})).data.events.length, 3);
    assert.equal((await api('/escalate', { call_id: 'missing' })).status, 404);
  });

  await t.test('immediate human handoff still reaches the live nudge detector', async () => {
    const before = requests;
    const turn = await api('/query', { call_id: 'handoff-nudge', query: 'I need to speak to a supervisor right now' });
    assert.equal(turn.status, 200);
    assert.equal(requests, before);
    assert.equal(turn.data.escalation.priority, 'HIGH');
    let nudges = [];
    for (let attempt = 0; attempt < 20 && !nudges.length; attempt += 1) {
      nudges = (await api('/../nudges?call_id=handoff-nudge')).data.nudges;
      if (!nudges.length) await delay(20);
    }
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0].type, 'human_escalation');
    await api('/session/handoff-nudge/end', {});
  });

  await t.test('ended calls are archived, removed from live view and cannot reopen', async () => {
    await api('/session/review-call/end', {});
    const first = (await api('/session/review-call')).data;
    assert.equal(first.status, 'completed');
    assert.equal(first.outcome, 'human_handoff_requested');
    assert.equal(first.turns.length, 4);
    await api('/session/review-call/end', {});
    assert.equal((await api('/session/review-call')).data.ended_at, first.ended_at);
    assert.equal((await api('/session/review-call/playbook')).status, 404);
    assert.equal((await api('/live')).data.calls.length, 0);
    assert.equal((await api('/query', { call_id: 'review-call', query: 'hello' })).status, 409);
    assert.equal((await api('/session', { call_id: 'review-call' })).status, 409);
    await api('/webhook', { message: { type: 'transcript', call: { id: 'review-call' }, role: 'user', transcript: 'late', transcriptType: 'final' } });
    assert.equal((await api('/session/review-call')).data.turns.length, 4);
    assert.equal((await api(`/../handoffs/${reviewDeliveryId}`)).data.state, 'acknowledged');
    assert.equal((await api(`/../handoffs/${reviewDeliveryId}/resolve`, {})).status, 400);
    const resolved = await api(`/../handoffs/${reviewDeliveryId}/resolve`, { resolution: 'Supervisor contacted the customer and recorded the next step.' });
    assert.equal(resolved.data.state, 'resolved');
    assert.equal(resolved.data.events.at(-1).action, 'resolved');
    assert.equal((await api(`/../handoffs/${reviewDeliveryId}/resolve`, { resolution: 'Duplicate retry' })).data.events.length, 4);
  });

  await t.test('greetings and missing knowledge remain recoverable in the same call', async () => {
    const before = requests;
    const greeting = await api('/query', { call_id: 'unsupported', query: 'Hello' });
    assert.equal(greeting.data.response_kind, 'conversation');
    assert.equal(requests, before);
    const result = await api('/query', { call_id: 'unsupported', query: 'unknown' });
    assert.equal(result.data.escalation, null);
    assert.match(result.data.answer, /could not find supporting knowledge/);
    assert.doesNotMatch(result.data.answer, /has been recorded/);
    assert.equal(result.data.session.status, 'active');
    assert.equal(result.data.abstention_reason, 'insufficient_support');
    const repeatedGap = await api('/query', { call_id: 'unsupported', query: 'unknown' });
    assert.equal(repeatedGap.data.abstention_reason, 'insufficient_support');
    const gapInbox = await api('/../knowledge/gaps?status=active');
    assert.equal(gapInbox.status, 200);
    assert.equal(gapInbox.data.total, 1);
    assert.equal(gapInbox.data.gaps[0].occurrence_count, 2);
    assert.equal(gapInbox.data.gaps[0].question_excerpt, 'unknown');
    knowledgeGapId = gapInbox.data.gaps[0].id;
    const triaged = await api(`/../knowledge/gaps/${knowledgeGapId}/actions`, { status: 'triaged' });
    assert.equal(triaged.data.status, 'triaged');
    assert.ok(triaged.data.events.at(-1).actor_id);
    const closed = await api(`/../knowledge/gaps/${knowledgeGapId}/actions`, { status: 'out_of_scope', note: 'Not part of the approved pilot scope.' });
    assert.equal(closed.data.status, 'out_of_scope');
    const reopened = await api('/query', { call_id: 'unsupported', query: 'unknown' });
    assert.equal(reopened.data.abstention_reason, 'insufficient_support');
    const reopenedGap = await api(`/../knowledge/gaps/${knowledgeGapId}`);
    assert.equal(reopenedGap.data.status, 'reopened');
    assert.equal(reopenedGap.data.occurrence_count, 3);
    assert.equal(reopenedGap.data.resolution_note, null);
    assert.equal((await api(`/../knowledge/gaps/${knowledgeGapId}/actions`, { status: 'resolved', note: 'Covered' })).status, 400);
    assert.equal((await api(`/../knowledge/gaps/${knowledgeGapId}/actions`, { status: 'invalid' })).status, 400);
    const recovered = await api('/query', { call_id: 'unsupported', query: 'loan income' });
    assert.equal(requests, before + 4);
    assert.equal(recovered.data.answer, 'Policy answer');
    assert.equal(recovered.data.sources[0].source, 'loan-policy');
    assert.equal(recovered.data.session.escalations.length, 0);
    await api('/session/unsupported/end', {});
    assert.equal((await api('/session/unsupported')).data.outcome, 'completed');
  });

  await t.test('unsupported candidates are not displayed as citations or treated as a handoff', async () => {
    const result = await api('/query', { call_id: 'abstained', query: 'unsupported-with-source' });
    assert.equal(result.status, 200);
    assert.equal(result.data.escalation, null);
    assert.equal(result.data.abstention_reason, 'insufficient_support');
    assert.equal(result.data.session.status, 'active');
    assert.equal(result.data.session.turns.at(-1).sources.length, 0);
    assert.equal(result.data.sources.length, 0);
    await api('/session/abstained/end', {});
  });

  await t.test('concurrent turns and responses arriving after hangup cannot mutate history', async () => {
    const pending = api('/query', { call_id: 'slow-call', query: 'slow' });
    await slowStarted;
    assert.equal((await api('/query', { call_id: 'slow-call', query: 'other' })).status, 409);
    await api('/session/slow-call/end', {});
    releaseSlow();
    assert.equal((await pending).status, 409);
    assert.equal((await api('/session/slow-call')).data.turns.length, 1);
  });

  await t.test('history survives gateway restart and validates pagination', async () => {
    await api('/query', { call_id: 'recover-active', query: 'loan income' });
    const signal = await api('/../transcript/signal', { call_id: 'recover-active', signals: [], nudge: {
      type: 'buying_signal', text: 'Offer the next step.', priority: 'LOW', confidence: 0.8,
    } });
    assert.equal(signal.status, 200);
    const nudge = (await api('/../nudges?call_id=recover-active')).data.nudges[0];
    assert.equal((await api(`/../nudges/${nudge.id}/actions`, { action: 'acknowledged' })).status, 200);
    assert.equal((await api(`/../nudges/${nudge.id}/actions`, { action: 'useful' })).status, 200);
    assert.equal((await api(`/../nudges/${nudge.id}/actions`, { action: 'dismissed' })).status, 409);
    assert.equal((await api(`/../nudges/${nudge.id}/actions`, { action: 'bogus' })).status, 400);
    await stop();
    await start();
    const restored = (await api('/../nudges?call_id=recover-active')).data.nudges[0];
    assert.equal(restored.id, nudge.id);
    assert.equal(restored.status, 'acknowledged');
    assert.equal(restored.feedback, 'useful');
    const events = (await api(`/../nudges/${nudge.id}/events`)).data.events;
    assert.deepEqual(events.map((event) => event.action), ['created', 'acknowledged', 'useful']);
    assert.ok(events[1].actor_id);
    const history = await api('/history?limit=1&offset=0');
    assert.equal(history.data.total, 8);
    assert.equal(history.data.calls.length, 1);
    assert.equal(history.data.calls[0].turns, undefined);
    assert.equal((await api('/session/review-call')).data.escalations.length, 1);
    assert.equal((await api(`/../handoffs/${reviewDeliveryId}`)).data.state, 'resolved');
    const persistedGap = await api(`/../knowledge/gaps/${knowledgeGapId}`);
    assert.equal(persistedGap.data.occurrence_count, 3);
    assert.equal(persistedGap.data.status, 'reopened');
    assert.equal((await api('/history?limit=-1')).status, 400);
    assert.equal((await api('/history?offset=0.5')).status, 400);
    const live = (await api('/live')).data.calls;
    assert.equal(live.length, 1);
    assert.equal(live[0].call_id, 'recover-active');
    const recoveredSession = (await api('/session/recover-active')).data;
    assert.equal(recoveredSession.turns.length, 2);
    assert.equal(recoveredSession.turns[1].sources[0].page, 7);
    const recoveredPlaybook = await api('/session/recover-active/playbook');
    assert.equal(recoveredPlaybook.data.playbook.version, '2026-10-06.1');
    assert.ok(recoveredPlaybook.data.playbook.observed_steps >= 1);
    const resumed = await api('/query', { call_id: 'recover-active', query: 'loan amount' });
    assert.equal(resumed.data.session.turns.length, 4);
    await api('/session/recover-active/end', {});
  });

  await t.test('old automatic handoffs recover after restart while explicit handoffs remain paused', async () => {
    const original = await api('/query', { call_id: 'legacy-gap', query: 'unknown' });
    const session = original.data.session;
    session.status = 'escalated';
    session.escalations = [{ escalation_id: 'old-automatic', reason: 'no_eligible_candidates', timestamp: new Date().toISOString() }];
    await stop();
    const db = new DatabaseSync(join(directory, 'test.sqlite'));
    db.prepare('UPDATE calls SET status = ?, payload = ? WHERE id = ?').run('escalated', JSON.stringify(session), 'legacy-gap');
    db.close();
    await start();
    const recovered = await api('/query', { call_id: 'legacy-gap', query: 'loan income' });
    assert.equal(recovered.data.answer, 'Policy answer');
    assert.equal(recovered.data.session.status, 'active');
    assert.ok(recovered.data.session.escalations[0].resolved_at);
    const handoff = await api('/query', { call_id: 'legacy-gap', query: 'I want to talk to a human' });
    assert.equal(handoff.data.session.escalations.length, 2);
    const before = requests;
    const paused = await api('/query', { call_id: 'legacy-gap', query: 'loan income' });
    assert.equal(requests, before);
    assert.equal(paused.data.escalation.escalation_id, handoff.data.escalation.escalation_id);
    await api('/session/legacy-gap/end', {});
    assert.equal((await api('/session/legacy-gap')).data.outcome, 'human_handoff_requested');
  });

  await t.test('authentication protects reads, mutations and rejects cross-origin requests', async () => {
    assert.equal((await fetch(`${base}/history`)).status, 401);
    assert.equal((await fetch(base.replace('/voice', '/nudges'))).status, 401);
    assert.equal((await fetch(base.replace('/voice', '/handoffs'))).status, 401);
    const crossOrigin = await fetch(`${base}/session`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(crossOrigin.status, 403);
    const authBase = base.replace('/voice', '/auth');
    const send = (path, body) => fetch(`${authBase}${path}`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await send('/setup', owner)).status, 409);
    assert.equal((await send('/logout', {})).status, 200);
    assert.equal((await api('/history')).status, 401);
    assert.equal((await send('/login', { ...owner, password: 'wrong' })).status, 401);
    const login = await send('/login', owner);
    assert.equal(login.status, 200);
    const previous = cookie;
    cookie = login.headers.get('set-cookie').split(';')[0];
    assert.notEqual(cookie, previous);
    assert.equal((await api('/history')).status, 200);
  });

  await t.test('provider tokens authorize only callback endpoints', async () => {
    const headers = { Authorization: 'Bearer test-provider-token-with-at-least-32-characters', 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${base}/history`, { headers })).status, 401);
    const callback = await fetch(`${base}/webhook`, { method: 'POST', headers, body: JSON.stringify({ message: { type: 'speech-update' } }) });
    assert.equal(callback.status, 200);
    const invalid = await fetch(`${base}/webhook`, { method: 'POST', headers: { ...headers, Authorization: 'Bearer wrong', Origin: 'http://localhost:3000' }, body: '{}' });
    assert.equal(invalid.status, 401);
  });

  await t.test('live events require authentication and logout disconnects existing sockets', async () => {
    await api('/query', { call_id: 'socket-nudge', query: 'nudge-trigger' });
    let records = [];
    for (let attempt = 0; attempt < 20 && !records.length; attempt += 1) {
      records = (await api('/../nudges?call_id=socket-nudge')).data.nudges;
      if (!records.length) await delay(20);
    }
    assert.equal(records.length, 1);
    const url = base.replace('/api/voice', '');
    const rejected = connectSocket(url, { reconnection: false, transports: ['websocket'] });
    t.after(() => rejected.disconnect());
    const [error] = await once(rejected, 'connect_error');
    assert.match(error.message, /Authentication required/);
    rejected.disconnect();
    const socket = connectSocket(url, { reconnection: false, transports: ['websocket'], extraHeaders: { Cookie: cookie, Origin: 'http://localhost:3000' } });
    t.after(() => socket.disconnect());
    await once(socket, 'connect');
    const dismissal = await new Promise((resolve) => socket.emit('nudge:dismiss', { nudge_id: records[0].id }, resolve));
    assert.equal(dismissal.nudge.status, 'dismissed');
    assert.ok(dismissal.nudge.acted_by);
    assert.equal((await api('/../nudges?call_id=socket-nudge')).data.nudges[0].status, 'dismissed');
    const disconnected = once(socket, 'disconnect');
    const result = await fetch(base.replace('/voice', '/auth/logout'), { method: 'POST', headers: { Cookie: cookie, Origin: 'http://localhost:3000' } });
    assert.equal(result.status, 200);
    const [reason] = await disconnected;
    assert.equal(reason, 'io server disconnect');
  });
});
