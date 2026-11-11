import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import { getDatabase } from './database.js';

const SCHEMA_VERSION = 'call-summary.v2';
const FALLBACK_GENERATOR = 'deterministic_fallback.v2';
const SECTION_IDS = [
  'customer_intent',
  'customer_facts',
  'assistance_provided',
  'conversation_quality',
  'unresolved_issues',
  'handoff_state',
  'next_actions',
];

const REPAIR_CUE = /\b(?:could you (?:repeat|say that again|explain|clarify)|can you (?:repeat|say that again|explain|clarify)|please (?:repeat|explain|clarify)|(?:i (?:do not|don't) understand)|(?:i am|i'm) confused|what do you mean|say that again|p(?:wede|uwede) mo bang ulitin|pakiulit|hindi ko maintindihan|nalilito ako|ano(?:ng)? ibig sabihin|bisa (?:di)?ulangi|tolong ulangi|saya (?:tidak|tak) mengerti|saya bingung|apa maksud(?:nya)?)\b/i;
const REPAIR_RESPONSE_CUE = /(?:\b(?:sorry|understand|repeat|rephrase)\b|\b(?:apologi[sz]|clarif|explain)\w*|\blet me (?:put|explain|clarify)\b|pasensya|paumanhin|naiintindihan|ipaliwanag|ulitin|maaf|mengerti|jelas(?:kan)?|ulang)/i;

const revisionSchema = z.object({
  sections: z.record(z.string(), z.string().max(4_000)).default({}),
  follow_up_actions: z.array(z.string().trim().min(1).max(1_000)).max(10).default([]),
}).strict();

function cleanText(value, maximum = 280) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maximum) return text;
  return `${text.slice(0, maximum - 1).trimEnd()}…`;
}

function turnEvidence(session, turnIndex, includeSources = false) {
  if (turnIndex < 0 || !session.turns?.[turnIndex]) return [];
  const turn = session.turns[turnIndex];
  const evidence = [{ kind: 'turn', turn_index: turnIndex, role: turn.role }];
  if (!includeSources) return evidence;
  for (const [sourceIndex, source] of (turn.sources || []).entries()) {
    evidence.push({
      kind: 'citation',
      turn_index: turnIndex,
      source_index: sourceIndex,
      document_id: source.document_id || null,
      revision: source.revision || null,
      page: source.page || null,
      chunk_id: source.chunk_id || null,
      title: source.title || source.source || 'Knowledge source',
    });
  }
  return evidence;
}

function findLastTurn(session, predicate) {
  for (let index = (session.turns?.length || 0) - 1; index >= 0; index -= 1) {
    if (predicate(session.turns[index], index)) return index;
  }
  return -1;
}

function evidenceForValue(session, value) {
  const sought = String(value || '').replace(/\s+/g, '').toLowerCase();
  const index = findLastTurn(session, (turn) => turn.role === 'user'
    && String(turn.content || '').replace(/\s+/g, '').toLowerCase().includes(sought));
  const fallback = findLastTurn(session, (turn) => turn.role === 'user');
  return turnEvidence(session, index >= 0 ? index : fallback);
}

function section(id, title, items) {
  return { id, title, items: items.filter(Boolean) };
}

function item(text, evidence = [], maximum = 280) {
  return { id: randomUUID(), text: cleanText(text, maximum), evidence };
}

function nextAssistantTurn(session, afterIndex) {
  for (let index = afterIndex + 1; index < (session.turns?.length || 0); index += 1) {
    if (session.turns[index].role === 'assistant') return index;
    if (session.turns[index].role === 'user') return -1;
  }
  return -1;
}

function conversationQualityItems(session) {
  const repairTurns = (session.turns || [])
    .map((turn, turnIndex) => ({ turn, turnIndex }))
    .filter(({ turn }) => turn.role === 'user' && REPAIR_CUE.test(turn.content || ''))
    .slice(0, 3);

  return repairTurns.map(({ turnIndex }) => {
    const responseIndex = nextAssistantTurn(session, turnIndex);
    if (responseIndex < 0) {
      return item(
        'A customer clarification or repeat request was detected, but no subsequent agent response was recorded. Review the recovery.',
        turnEvidence(session, turnIndex),
      );
    }

    const response = session.turns[responseIndex];
    const evidence = [...turnEvidence(session, turnIndex), ...turnEvidence(session, responseIndex)];
    if (REPAIR_RESPONSE_CUE.test(response.content || '')) {
      return item(
        'The response after a customer clarification or repeat request contains an acknowledgement or clarification cue. Review whether it resolved the concern.',
        evidence,
      );
    }
    return item(
      'A customer clarification or repeat request was followed by an agent response without an explicit acknowledgement or clarification cue. Review the recovery.',
      evidence,
    );
  });
}

function callDurationMs(session) {
  const startedAt = Date.parse(session.started_at || session.created_at || '');
  const endedAt = Date.parse(session.ended_at || '');
  return Number.isFinite(startedAt) && Number.isFinite(endedAt)
    ? Math.max(0, endedAt - startedAt)
    : null;
}

function intentDescription(intent) {
  if (intent === 'loan_inquiry') return 'The customer asked about a loan.';
  if (intent === 'insurance_inquiry') return 'The customer asked about insurance.';
  return 'No specific product intent was confirmed.';
}

function buildDraft(session) {
  const latestCustomerIndex = findLastTurn(session, (turn) => turn.role === 'user');
  const intentIndex = findLastTurn(session, (turn) => turn.role === 'user'
    && /\b(loan|emi|ltv|property|cibil|income|insurance|claim|coverage|premium|policy|rider|beneficiary)\b/i.test(turn.content || ''));
  const facts = [];
  if (session.state?.customer_name) {
    facts.push(item(`Customer name: ${session.state.customer_name}.`, evidenceForValue(session, session.state.customer_name)));
  }
  if (session.state?.income) {
    facts.push(item(`Stated income: ${session.state.income}.`, evidenceForValue(session, session.state.income)));
  }
  if (session.state?.loan_amount) {
    facts.push(item(`Requested loan amount: ${session.state.loan_amount}.`, evidenceForValue(session, session.state.loan_amount)));
  }

  const assistance = (session.turns || [])
    .map((turn, turnIndex) => ({ turn, turnIndex }))
    .filter(({ turn }) => turn.role === 'assistant')
    .slice(-3)
    .map(({ turn, turnIndex }) => item(turn.content, turnEvidence(session, turnIndex, true)));

  const unresolved = [];
  const unsupportedIndex = findLastTurn(session, (turn) => ['clarification', 'guidance_abstention'].includes(turn.response_kind));
  if (unsupportedIndex >= 0) {
    unresolved.push(item('The conversation contains a question that was not answered with supporting knowledge.', turnEvidence(session, unsupportedIndex)));
  }
  const missingFields = session.state?.missing_fields || [];
  if (missingFields.length > 0 && latestCustomerIndex >= 0) {
    unresolved.push(item(`Details still missing at call end: ${missingFields.join(', ')}.`, turnEvidence(session, latestCustomerIndex)));
  }

  const activeEscalation = (session.escalations || []).findLast((entry) => !entry.resolved_at);
  const latestEscalation = (session.escalations || []).at(-1);
  const handoffItems = [];
  if (activeEscalation) {
    handoffItems.push(item(`Human assistance was requested: ${activeEscalation.reason}.`, turnEvidence(session, latestCustomerIndex)));
  } else if (latestEscalation?.resolved_at) {
    handoffItems.push(item('A previous handoff signal was resolved before the call ended.', turnEvidence(session, latestCustomerIndex)));
  }

  const nextActions = [];
  if (activeEscalation) {
    nextActions.push(item('Follow up on the open human-assistance request.', turnEvidence(session, latestCustomerIndex)));
  }
  if (unsupportedIndex >= 0) {
    nextActions.push(item('Review the unsupported question and provide an approved answer if follow-up is required.', turnEvidence(session, unsupportedIndex)));
  }
  if (nextActions.length === 0 && latestCustomerIndex >= 0) {
    nextActions.push(item('Review the call outcome and confirm whether any customer follow-up is required.', turnEvidence(session, latestCustomerIndex)));
  }

  return {
    sections: [
      section('customer_intent', 'Customer intent', [
        item(intentDescription(session.state?.intent), turnEvidence(session, intentIndex >= 0 ? intentIndex : latestCustomerIndex)),
      ]),
      section('customer_facts', 'Customer-stated facts', facts),
      section('assistance_provided', 'Assistance provided', assistance),
      section('conversation_quality', 'Conversation recovery signals', conversationQualityItems(session)),
      section('unresolved_issues', 'Unresolved issues', unresolved),
      section('handoff_state', 'Handoff state', handoffItems),
      section('next_actions', 'Recommended next actions', nextActions),
    ],
    follow_up_actions: nextActions.map((entry) => ({
      id: randomUUID(),
      text: entry.text,
      status: 'proposed',
      created_source: 'generated',
      evidence: entry.evidence,
    })),
  };
}

function snapshotHash(session) {
  const snapshot = {
    call_id: session.call_id,
    ended_at: session.ended_at,
    outcome: session.outcome,
    state: session.state,
    turns: session.turns,
    escalations: session.escalations,
  };
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function parseRow(row) {
  if (!row) return null;
  return JSON.parse(row.payload);
}

function insertEvent(db, summaryId, actorId, action, payload = null) {
  db.prepare(`INSERT INTO call_summary_events
    (summary_id, actor_id, action, created_at, payload) VALUES (?, ?, ?, ?, ?)`)
    .run(summaryId, actorId || null, action, new Date().toISOString(), payload ? JSON.stringify(payload) : null);
}

function nextVersion(db, callId) {
  return db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM call_summaries WHERE call_id=?')
    .get(callId).version;
}

function createRecord({ session, version, generator, createdBy = null, parentSummaryId = null, content }) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    workspace_id: session.workspace_id || 'default',
    call_id: session.call_id,
    version,
    state: 'draft',
    generation_state: 'completed',
    generator,
    schema_version: SCHEMA_VERSION,
    prompt_version: null,
    model: null,
    provider_usage: null,
    input_hash: snapshotHash(session),
    parent_summary_id: parentSummaryId,
    source_snapshot: {
      started_at: session.started_at || session.created_at,
      ended_at: session.ended_at,
      turn_count: session.turns?.length || 0,
      duration_ms: callDurationMs(session),
    },
    created_by: createdBy,
    created_at: now,
    updated_at: now,
    ...content,
  };
}

function saveRecord(db, record) {
  db.prepare(`INSERT INTO call_summaries
    (id, workspace_id, call_id, version, state, generator, input_hash, created_by, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(record.id, record.workspace_id, record.call_id, record.version, record.state,
      record.generator, record.input_hash, record.created_by, record.created_at,
      record.updated_at, JSON.stringify(record));
}

function requireSummary(db, callId, summaryId) {
  const summary = parseRow(db.prepare('SELECT payload FROM call_summaries WHERE id=? AND call_id=?').get(summaryId, callId));
  if (!summary) throw Object.assign(new Error('Summary version not found'), { status: 404 });
  return summary;
}

export function getCallSummaryStore() {
  const db = getDatabase();
  return {
    ensureDraft(session) {
      if (!session || session.status !== 'completed') {
        throw Object.assign(new Error('A completed call is required'), { status: 409 });
      }
      const inputHash = snapshotHash(session);
      const existing = parseRow(db.prepare(`SELECT payload FROM call_summaries
        WHERE call_id=? AND input_hash=? AND generator=? ORDER BY version DESC LIMIT 1`)
        .get(session.call_id, inputHash, FALLBACK_GENERATOR));
      if (existing) return existing;

      db.exec('BEGIN IMMEDIATE');
      try {
        const record = createRecord({
          session,
          version: nextVersion(db, session.call_id),
          generator: FALLBACK_GENERATOR,
          content: buildDraft(session),
        });
        saveRecord(db, record);
        insertEvent(db, record.id, null, 'generated', {
          generator: record.generator,
          input_hash: record.input_hash,
        });
        db.exec('COMMIT');
        return record;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    getForCall(callId) {
      const versions = db.prepare('SELECT payload FROM call_summaries WHERE call_id=? ORDER BY version DESC')
        .all(callId).map(parseRow);
      return { latest: versions[0] || null, versions };
    },

    revise(session, summaryId, actorId, input) {
      const parsed = revisionSchema.safeParse(input);
      if (!parsed.success) {
        throw Object.assign(new Error('Summary revision is invalid'), { status: 400 });
      }
      const values = parsed.data;
      const source = requireSummary(db, session.call_id, summaryId);
      const requestedSections = values.sections;
      const sections = source.sections.map((currentSection) => {
        if (!SECTION_IDS.includes(currentSection.id) || !(currentSection.id in requestedSections)) return currentSection;
        const items = requestedSections[currentSection.id]
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 10)
          .map((text, index) => item(
            text,
            currentSection.items[index]?.evidence
              || currentSection.items.flatMap((entry) => entry.evidence || []),
            1_000,
          ));
        return { ...currentSection, items };
      });
      const existingActionEvidence = source.follow_up_actions?.flatMap((entry) => entry.evidence || []) || [];
      const followUpActions = values.follow_up_actions.map((text, index) => ({
        id: randomUUID(),
        text,
        status: 'proposed',
        created_source: 'operator_edit',
        evidence: source.follow_up_actions?.[index]?.evidence || existingActionEvidence,
      }));

      db.exec('BEGIN IMMEDIATE');
      try {
        const record = createRecord({
          session,
          version: nextVersion(db, session.call_id),
          generator: 'operator_edit',
          createdBy: actorId,
          parentSummaryId: source.id,
          content: { sections, follow_up_actions: followUpActions },
        });
        saveRecord(db, record);
        insertEvent(db, source.id, actorId, 'revision_created', { revision_id: record.id, version: record.version });
        insertEvent(db, record.id, actorId, 'created_from_revision', { parent_summary_id: source.id });
        db.exec('COMMIT');
        return record;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    accept(callId, summaryId, actorId) {
      const summary = requireSummary(db, callId, summaryId);
      if (summary.state === 'accepted') return summary;
      if (summary.state !== 'draft') {
        throw Object.assign(new Error('Only a draft summary can be accepted'), { status: 409 });
      }
      const latest = db.prepare('SELECT id FROM call_summaries WHERE call_id=? ORDER BY version DESC LIMIT 1').get(callId);
      if (latest?.id !== summary.id) {
        throw Object.assign(new Error('Only the latest summary version can be accepted'), { status: 409 });
      }
      const now = new Date().toISOString();
      const accepted = {
        ...summary,
        state: 'accepted',
        accepted_by: actorId,
        accepted_at: now,
        updated_at: now,
      };
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE call_summaries SET state=?, updated_at=?, payload=? WHERE id=?')
          .run(accepted.state, accepted.updated_at, JSON.stringify(accepted), accepted.id);
        insertEvent(db, accepted.id, actorId, 'accepted');
        db.exec('COMMIT');
        return accepted;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
