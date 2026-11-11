import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDatabase } from './database.js';

const inputSchema = z.object({
  type: z.enum(['missed_cross_sell', 'compliance_gap', 'rising_frustration', 'payment_difficulty', 'buying_signal', 'human_escalation', 'knowledge_tip']),
  text: z.string().trim().min(1).max(2000),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  confidence: z.number().min(0).max(1).nullable().optional().default(null),
  suggested_response: z.string().trim().min(1).max(8000).optional(),
  context_query: z.string().trim().min(1).max(8000).optional(),
  sources: z.array(z.record(z.string(), z.unknown())).max(5).optional().default([]),
  origin: z.enum(['customer_turn', 'operator_query']).optional().default('customer_turn'),
  requested_by: z.string().trim().min(1).max(200).nullable().optional().default(null),
  latency_ms: z.number().min(0).optional().default(0),
  expires_after_seconds: z.number().min(1).max(300).optional().default(45),
});
export const GUIDANCE_DISMISS_REASONS = [
  'not_relevant',
  'incorrect_or_unsupported',
  'too_verbose',
  'already_answered',
  'prefer_human',
  'other',
];
export const nudgeActionSchema = z.object({
  action: z.enum(['displayed', 'acknowledged', 'dismissed', 'useful', 'not_useful', 'wrong_signal', 'too_late']),
  reason: z.enum(GUIDANCE_DISMISS_REASONS).optional(),
}).strict();
const active = (nudge) => ['created', 'displayed'].includes(nudge.status);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

export function createNudgeStore(db = getDatabase(), now = () => Date.now()) {
  const stamp = () => new Date(now()).toISOString();
  const read = (id) => {
    const row = db.prepare('SELECT payload FROM nudges WHERE id=?').get(id);
    return row ? JSON.parse(row.payload) : null;
  };
  function save(nudge, action, actor = null, eventPayload = null) {
    db.prepare('INSERT INTO nudges VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload')
      .run(nudge.id, nudge.call_id, nudge.status, nudge.expires_at, JSON.stringify(nudge));
    db.prepare('INSERT INTO nudge_events(nudge_id, actor_id, action, created_at, payload) VALUES (?, ?, ?, ?, ?)')
      .run(nudge.id, actor, action, stamp(), eventPayload ? JSON.stringify(eventPayload) : null);
  }
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function expire() {
    const rows = db.prepare("SELECT payload FROM nudges WHERE status IN ('created', 'displayed') AND (expires_at<=? OR call_id IN (SELECT id FROM calls WHERE status='completed'))").all(stamp());
    if (!rows.length) return;
    transaction(() => rows.forEach((row) => {
      const nudge = JSON.parse(row.payload);
      save({ ...nudge, status: 'expired', updated_at: stamp() }, 'expired');
    }));
  }
  return {
    create(callId, input) {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) fail(400, 'Invalid nudge payload');
      const call = db.prepare('SELECT status FROM calls WHERE id=?').get(callId);
      if (!call) fail(404, 'Call not found');
      if (call.status === 'completed') fail(409, 'Call has ended');
      expire();
      const recent = db.prepare("SELECT payload FROM nudges WHERE call_id=? ORDER BY json_extract(payload, '$.created_at') DESC LIMIT 50").all(callId).map((row) => JSON.parse(row.payload));
      const duplicate = recent.find((n) =>
        n.type === parsed.data.type &&
        n.text === parsed.data.text &&
        now() - Date.parse(n.created_at) < 15000 &&
        (parsed.data.type !== 'knowledge_tip' || (
          active(n) &&
          n.context_query === parsed.data.context_query &&
          n.suggested_response === parsed.data.suggested_response
        ))
      );
      if (duplicate) return { nudge: duplicate, created: false };
      const nudge = { ...parsed.data, id: randomUUID(), call_id: callId, status: 'created', feedback: null,
        created_at: stamp(), updated_at: stamp(), ts: stamp(), expires_at: new Date(now() + parsed.data.expires_after_seconds * 1000).toISOString() };
      transaction(() => {
        const pending = db.prepare("SELECT payload FROM nudges WHERE call_id=? AND status IN ('created', 'displayed')").all(callId).map((row) => JSON.parse(row.payload));
        const capacityPool = nudge.type === 'knowledge_tip'
          ? pending.filter((item) => item.type === 'knowledge_tip')
          : pending.filter((item) => item.type !== 'knowledge_tip');
        const capacity = nudge.type === 'knowledge_tip' ? 1 : 3;
        if (capacityPool.length >= capacity) {
          const weight = { LOW: 0, MEDIUM: 1, HIGH: 2 };
          const victim = capacityPool.sort((a, b) => weight[a.priority] - weight[b.priority] || a.created_at.localeCompare(b.created_at))[0];
          if (weight[victim.priority] > weight[nudge.priority]) fail(409, 'Higher-priority nudges are already active');
          save({ ...victim, status: 'expired', updated_at: stamp() }, 'replaced');
        }
        save(nudge, 'created');
      });
      return { nudge, created: true };
    },
    list(callId, limit = 100) {
      expire();
      return (callId
        ? db.prepare("SELECT payload FROM nudges WHERE call_id=? ORDER BY json_extract(payload, '$.created_at') DESC, id LIMIT ?").all(callId, limit)
        : db.prepare("SELECT payload FROM nudges ORDER BY json_extract(payload, '$.created_at') DESC, id LIMIT ?").all(limit))
        .map((row) => JSON.parse(row.payload));
    },
    get(id) {
      expire();
      return read(id);
    },
    apply(id, actor, options, persistTurn) {
      expire();
      const nudge = read(id);
      if (!nudge) fail(404, 'Nudge not found');
      if (nudge.type !== 'knowledge_tip' || !nudge.suggested_response) fail(409, 'This nudge cannot guide a response');
      if (nudge.status === 'applied') return { nudge, applied: false };
      if (!active(nudge)) fail(409, 'This nudge is already resolved or expired');
      const appliedResponse = typeof options?.responseText === 'string'
        ? options.responseText.trim()
        : nudge.suggested_response;
      if (!appliedResponse || appliedResponse.length > 8000) fail(400, 'Applied response must be between 1 and 8000 characters');
      if (typeof persistTurn !== 'function') fail(500, 'A persistence callback is required');
      const updated = {
        ...nudge,
        status: 'applied',
        applied_response: appliedResponse,
        was_edited: appliedResponse !== nudge.suggested_response,
        applied_at: stamp(),
        acted_by: actor,
        acted_at: stamp(),
        updated_at: stamp(),
      };
      transaction(() => {
        persistTurn(nudge, appliedResponse);
        save(updated, 'applied', actor);
      });
      return { nudge: updated, applied: true };
    },
    act(id, action, actor, options = {}) {
      if (!nudgeActionSchema.safeParse({ action, reason: options.reason }).success) fail(400, 'Invalid nudge action');
      expire();
      const nudge = read(id);
      if (!nudge) fail(404, 'Nudge not found');
      if (nudge.type === 'knowledge_tip' && action === 'dismissed' && !options.reason) {
        fail(400, 'A dismissal reason is required for grounded guidance');
      }
      const isFeedback = ['useful', 'not_useful', 'wrong_signal', 'too_late'].includes(action);
      if (isFeedback ? nudge.feedback === action : nudge.status === action) return nudge;
      if (!isFeedback && !active(nudge)) fail(409, 'This nudge is already resolved or expired');
      const actionAt = stamp();
      const lifecycleFields = action === 'displayed'
        ? { displayed_at: nudge.displayed_at || actionAt }
        : action === 'dismissed'
          ? { dismissed_at: actionAt, dismiss_reason: options.reason || null }
          : action === 'acknowledged'
            ? { acknowledged_at: actionAt }
            : {};
      const updated = { ...nudge, updated_at: actionAt, ...lifecycleFields, ...(isFeedback
        ? { feedback: action, feedback_by: actor, feedback_at: stamp() }
        : { status: action, acted_by: actor, acted_at: stamp() }) };
      transaction(() => save(updated, action, actor, options.reason ? { reason: options.reason } : null));
      return updated;
    },
    events(id) {
      expire();
      if (!read(id)) fail(404, 'Nudge not found');
      return db.prepare('SELECT actor_id, action, created_at, payload FROM nudge_events WHERE nudge_id=? ORDER BY id').all(id)
        .map((event) => ({
          ...event,
          payload: event.payload ? JSON.parse(event.payload) : null,
        }));
    },
  };
}

let store;
export const getNudgeStore = () => (store ||= createNudgeStore());
