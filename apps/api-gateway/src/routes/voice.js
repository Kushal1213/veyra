import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { io, logger } from '../index.js';
import { createCallHistory } from '../services/call-history.js';
import { getCallSummaryStore } from '../services/call-summaries.js';
import { getNudgeStore } from '../services/nudges.js';
import { persistHandoffEscalation } from '../services/handoff-deliveries.js';
import { recordKnowledgeGap } from '../services/knowledge-gaps.js';
import { evaluatePlaybook } from '../services/playbooks.js';
import { createDisclosureChecklistStore } from '../services/disclosure-checklists.js';
import { assertOperationalControl, isOperationalControlEnabled } from '../services/operational-controls.js';

const router = express.Router();

// In-memory conversation state store
const conversations = new Map();
const pendingTurns = new Set();
let history;
const callHistory = () => {
  if (!history) {
    history = createCallHistory();
    for (const session of history.active()) conversations.set(session.call_id, session);
  }
  return history;
};
router.use((_req, _res, next) => { callHistory(); next(); });
const isLive = (session) => ['created', 'active', 'escalated'].includes(session.status);

function finishSession(callId) {
  const session = conversations.get(callId);
  if (!session) return callHistory().get(callId);
  const finished = {
    ...session,
    status: 'completed',
    ended_at: new Date().toISOString(),
    summary: buildSummary(session),
    outcome: activeEscalation(session) ? 'human_handoff_requested' : 'completed',
  };
  callHistory().save(finished);
  try {
    getCallSummaryStore().ensureDraft(finished);
  } catch (error) {
    logger.warn({ call_id: callId, err: error.message }, 'After-call summary generation failed');
  }
  session.status = finished.status;
  conversations.delete(callId);
  io.emit('call:ended', { call_id: callId, session: finished, summary: finished.summary });
  emitLiveCallEnd(callId);
  return finished;
}

// ─── Latency Tracking ────────────────────────────────────────
const latencyHistory = [];
function recordLatency(entry) {
  latencyHistory.push({ ...entry, ts: Date.now() });
  if (latencyHistory.length > 200) latencyHistory.shift();
  io.emit('pipeline:latency', entry);
}

const MAX_QUERY_LENGTH = 8_000;
const MARKET_LANGUAGES = {
  'india-loan': 'en-IN',
  'india-insurance': 'en-IN',
  'ph-bancassurance': 'en-PH',
  'id-finance': 'id-ID',
};

const MARKET_DETAILS = {
  'india-loan': { label: 'India Loans', flag: '🇮🇳', agent: 'Aria (India Loans & Insurance)' },
  'india-insurance': { label: 'India Insurance', flag: '🇮🇳', agent: 'Priya (India Insurance)' },
  'ph-bancassurance': { label: 'Philippines Bancassurance', flag: '🇵🇭', agent: 'Maria (Taglish Agent)' },
  'id-finance': { label: 'Indonesia Finance', flag: '🇮🇩', agent: 'Dewi (Bahasa Agent)' },
};

const RAG_SCOPES = {
  'india-loan': { market: 'india', product: 'loan' },
  'india-insurance': { market: 'india', product: 'insurance' },
  'ph-bancassurance': { market: 'philippines', product: 'bancassurance' },
  'id-finance': { market: 'indonesia', product: 'finance' },
};

const getRagUrl = () => (process.env.RAG_SERVICE_URL || 'http://localhost:8001').replace(/\/+$/, '');

function scopeForMarket(market) {
  const key = String(market || '').trim().toLowerCase();
  const scope = RAG_SCOPES[key];
  if (!scope) {
    throw Object.assign(new Error('Unsupported market'), { status: 400 });
  }
  return { key, ...scope };
}

function getOrCreateSession(callId, overrides = {}) {
  if (!conversations.has(callId)) {
    if (callHistory().get(callId)?.status === 'completed') {
      throw Object.assign(new Error('This call has ended. Start a new session.'), { status: 409 });
    }
    if (overrides.market !== undefined) scopeForMarket(overrides.market);
    assertOperationalControl('new_sessions');
    conversations.set(callId, createSession(callId, overrides));
  }
  return conversations.get(callId);
}

function emitTurn(callId, turn) {
  const session = conversations.get(callId);
  if (session) {
    if (session.status === 'created') session.status = 'active';
    session.last_activity = turn.ts || new Date().toISOString();
  }
  io.emit('transcript:update', { call_id: callId, turn });
  if (session) emitLiveCallUpdate(session);
}

function getLatestTurn(session, role) {
  return [...session.turns].reverse().find((turn) => turn.role === role)?.content || '';
}

function intentLabel(intent) {
  if (intent === 'insurance_inquiry') return 'Insurance Inquiry';
  if (intent === 'loan_inquiry') return 'Loan Inquiry';
  return 'Listening for customer intent';
}

/**
 * Produce the small, browser-safe representation consumed by Mission Control.
 * Keeping it derived from the server-owned call session means Insights can load
 * after a call starts without depending on a previously-open Socket.IO tab.
 */
function buildLiveCall(session) {
  const market = MARKET_DETAILS[session.market] || MARKET_DETAILS['india-loan'];
  const customerTurn = getLatestTurn(session, 'user');
  const agentTurn = getLatestTurn(session, 'assistant');
  const conversationText = session.turns
    .filter((turn) => turn.role === 'user')
    .map((turn) => turn.content)
    .join(' ')
    .toLowerCase();
  const frustration = session.state.frustration_level || 0;
  const escalated = session.state.compliance_risk || frustration >= 0.5;
  const buyingSignal = /\b(apply|purchase|buy|eligible|eligibility|loan|premium|coverage|policy|amount)\b/i.test(conversationText) && !escalated;
  const latestNudge = session.state.last_nudge || null;
  const latestAssistantTurn = [...session.turns].reverse().find((turn) => turn.role === 'assistant');

  return {
    id: session.call_id,
    call_id: session.call_id,
    status: session.status || 'active',
    customer: session.state.customer_name || 'Live Customer',
    agent: market.agent,
    market: `${market.flag} ${market.label}`,
    intent: intentLabel(session.state.intent),
    sentiment: frustration >= 0.5 ? 'Negative' : frustration >= 0.2 ? 'Neutral' : 'Positive',
    sentimentScore: Number((1 - frustration).toFixed(2)),
    frustration,
    buyingSignal,
    complianceRisk: Boolean(session.state.compliance_risk),
    complianceRule: session.state.compliance_rule || 'NONE',
    timestamp: session.last_activity || session.created_at,
    latency: latestAssistantTurn?.latency_ms ? `${latestAssistantTurn.latency_ms.toLocaleString()}ms` : '—',
    query: customerTurn,
    answer: agentTurn,
    lastNudge: latestNudge,
  };
}

function emitLiveCallUpdate(session, persist = true) {
  if (persist) callHistory().save(session);
  io.emit('insights:call:update', { call: buildLiveCall(session) });
}

function emitLiveCallEnd(callId) {
  io.emit('insights:call:ended', { call_id: callId });
}

function updateConversationState(session, text) {
  const normalized = text.toLowerCase();
  const name = text.match(/(?:my name is|i am|i'm)\s+([a-z][a-z .'-]{1,50})/i);
  if (name) session.state.customer_name = name[1].trim().replace(/[.,!?].*$/, '');

  if (/\b(claim|coverage|premium|policy|insurance|rider|beneficiary)\b/i.test(text)) {
    session.state.intent = 'insurance_inquiry';
  } else if (/\b(loan|emi|ltv|property|cibil|income|cicilan|dp|tenor)\b/i.test(text)) {
    session.state.intent = 'loan_inquiry';
  }

  const income = text.match(/(?:income|salary|earn)\D{0,20}([₹$₱]?\s?[\d,.]+\s*(?:k|lakh|lakhs|thousand)?)/i);
  if (income) session.state.income = income[1].trim();
  const amount = text.match(/(?:loan|amount|need|borrow)\D{0,20}([₹$₱]?\s?[\d,.]+\s*(?:k|lakh|lakhs|crore|million)?)/i);
  if (amount) session.state.loan_amount = amount[1].trim();

  const frustrationTerms = ['manager', 'supervisor', 'human', 'complaint', 'unacceptable', 'ridiculous', 'frustrated', 'angry'];
  const frustrationHits = frustrationTerms.filter((term) => normalized.includes(term)).length;
  if (frustrationHits) {
    session.state.frustration_level = Math.min(1, session.state.frustration_level + frustrationHits * 0.25);
  }
  session.state.current_stage = session.state.intent ? 'grounding' : 'intent_capture';
  session.state.missing_fields = ['customer_name', 'intent', 'income'].filter((field) => !session.state[field]);
}

function escalationFor(session, text) {
  if (/\b(?:do not|don't|dont|no need to)\s+(?:want|need|speak to|talk to|transfer to)?\s*(?:a |an )?(?:human|manager|supervisor|representative)\b/i.test(text)) return null;
  if (!/\b(manager|supervisor|human|representative|escalat\w*|complaint|claim rejected)\b/i.test(text)) {
    return null;
  }
  return requestEscalation(session, 'Customer requested human assistance or raised a complaint');
}

function requestEscalation(session, reason) {
  if (activeEscalation(session)) {
    persistHandoffEscalation(session, activeEscalation(session));
    return activeEscalation(session);
  }
  const lastCustomerMessage = getLatestTurn(session, 'user');
  // The insights detector is asynchronous. Preserve an urgent customer request
  // on the durable handoff itself instead of waiting for detector-derived
  // frustration to arrive after the inbox delivery has already been written.
  const urgentRequest = /\b(?:supervisor|manager|complaint|urgent|immediately|right now)\b/i.test(lastCustomerMessage);
  const escalation = {
    escalation_id: uuidv4(),
    call_id: session.call_id,
    reason,
    trigger: 'human_request',
    customer_intent: session.state.intent,
    last_customer_message: lastCustomerMessage,
    sources: session.turns.filter((turn) => turn.role === 'assistant').at(-1)?.sources || [],
    missing_information: [...session.state.missing_fields],
    conversation_summary: buildSummary(session),
    confidence: session.state.confidence,
    timestamp: new Date().toISOString(),
    priority: urgentRequest || session.state.frustration_level >= 0.5 ? 'HIGH' : 'NORMAL',
  };
  session.status = 'escalated';
  session.state.current_stage = 'escalation';
  session.escalations.push(escalation);
  const delivery = persistHandoffEscalation(session, escalation);
  io.emit('call:escalated', { ...escalation, delivery });
  io.emit('handoff:updated', { handoff: delivery });
  emitLiveCallUpdate(session, false);
  return escalation;
}

function activeEscalation(session) {
  return session.escalations.findLast((item) => !item.resolved_at);
}

function recoverKnowledgeHandoff(session) {
  // Old releases treated missing evidence as a terminal handoff. Preserve that
  // audit record, but allow these specific automatic failures to retry.
  const reasons = new Set(['no_eligible_candidates', 'insufficient_support', 'knowledge_empty',
    'out_of_scope', 'No supporting knowledge was retrieved']);
  for (const item of session.escalations) {
    if (!item.trigger && !item.resolved_at && reasons.has(item.reason)) {
      item.resolved_at = new Date().toISOString();
      item.resolution = 'Knowledge lookup can be retried; no human handoff was requested.';
    }
  }
  if (session.status === 'escalated' && !activeEscalation(session)) session.status = 'active';
}

function conversationalReply(query, market) {
  const text = query.toLowerCase().replace(/[.!?,]/g, '').trim();
  if (/^(hi|hello|hey|good morning|good afternoon|good evening|halo|hai|selamat pagi|selamat siang|kumusta|magandang umaga)$/.test(text)) {
    return `Hello! I can help with ${MARKET_DETAILS[market].label.toLowerCase()}. What would you like to know?`;
  }
  if (/^(thanks|thank you|thank you very much|terima kasih|salamat)( so much)?$/.test(text)) return 'You’re welcome. What else would you like to know?';
  if (/^(help|what can you do|how can you help|who are you)$/.test(text)) return `I’m the Veyra assistant for ${MARKET_DETAILS[market].label.toLowerCase()}. Ask about requirements, documents, or product details. I’ll use the available knowledge and say when I can’t support an answer.`;
  return null;
}

async function runVoiceTurn(options) {
  if (pendingTurns.has(options.callId)) {
    throw Object.assign(new Error('A turn is already in progress for this call.'), { status: 409 });
  }
  pendingTurns.add(options.callId);
  try {
    return await processVoiceTurn(options);
  } finally {
    pendingTurns.delete(options.callId);
  }
}

async function processVoiceTurn({ callId, query, market, language, recordUser = true, emitUser = true, guidedMode = false }) {
  const startedAt = Date.now();
  const session = getOrCreateSession(callId, { market, language });
  recoverKnowledgeHandoff(session);
  const userTurn = createTranscriptTurn(session, { role: 'user', content: query, origin: 'browser' });

  if (recordUser) {
    session.turns.push(userTurn);
    updateConversationState(session, query);
  }
  if (emitUser) emitTurn(callId, userTurn);

  // Every customer turn must reach the live detector, including greetings and
  // requests that take the immediate human-handoff path below.
  feedToInsightsEngine(callId, 'customer', query).catch((err) => {
    logger.warn({ callId, err: err.message }, 'Live insights feed failed');
  });

  const handoff = activeEscalation(session) || escalationFor(session, query);
  if (handoff) {
    session.state.current_stage = 'escalation';
    const answer = 'Your request for human assistance has been recorded. A team member will need to take over this conversation.';
    const turn = createTranscriptTurn(session, { role: 'assistant', content: answer, sources: [], origin: 'browser' });
    session.turns.push(turn);
    emitTurn(callId, turn);
    return { call_id: callId, answer, sources: [], session, escalation: handoff, latency_ms: Date.now() - startedAt };
  }

  const greeting = conversationalReply(query, session.market);
  if (greeting) {
    session.state.current_stage = 'intent_capture';
    const turn = createTranscriptTurn(session, {
      role: 'assistant', content: greeting, sources: [], response_kind: 'conversation', origin: 'browser',
    });
    session.turns.push(turn);
    emitTurn(callId, turn);
    return { call_id: callId, answer: greeting, sources: [], response_kind: 'conversation', session, escalation: null, latency_ms: Date.now() - startedAt };
  }

  if (!isOperationalControlEnabled('customer_answer_generation')) {
    const answer = 'Automated knowledge answers are temporarily paused. I can still record a request for human assistance.';
    const turn = createTranscriptTurn(session, {
      role: 'assistant',
      content: answer,
      sources: [],
      response_kind: 'operational_pause',
      latency_ms: Date.now() - startedAt,
      origin: 'browser',
    });
    session.turns.push(turn);
    session.state.current_stage = 'restricted';
    emitTurn(callId, turn);
    return {
      call_id: callId,
      answer,
      sources: [],
      response_kind: 'operational_pause',
      session,
      escalation: null,
      latency_ms: turn.latency_ms,
    };
  }

  const ragScope = scopeForMarket(session.market);
  const ragStartedAt = Date.now();
  const ragResponse = await axios.post(
    `${getRagUrl()}/retrieve`,
    { query, top_k: 2, session_id: callId, market: ragScope.market, product: ragScope.product, language: session.language },
    { timeout: Number(process.env.RAG_REQUEST_TIMEOUT_MS || 10_000) }
  );
  const ragMs = Date.now() - ragStartedAt;
  if (!isLive(session)) throw Object.assign(new Error('This call has ended.'), { status: 409 });
  const totalMs = Date.now() - startedAt;
  const supportedAnswer = Boolean(ragResponse.data.sources?.length && !ragResponse.data.abstention_reason && ragResponse.data.answer);
  const sources = supportedAnswer ? ragResponse.data.sources : [];
  const reason = supportedAnswer ? null : (ragResponse.data.abstention_reason || 'insufficient_support');
  const answer = supportedAnswer
    ? ragResponse.data.answer
    : reason === 'knowledge_empty'
      ? 'No usable knowledge is available for this agent yet. An administrator needs to add and publish a document for this product. You can ask for human assistance.'
      : 'I could not find supporting knowledge for that question. Please name the product or rephrase your question. You can also ask to speak with a human.';
  if (!supportedAnswer) {
    recordKnowledgeGap({
      callId,
      market: ragScope.market,
      product: ragScope.product,
      reason,
      question: query,
    });
  }
  const assistantTurn = createTranscriptTurn(session, {
    role: 'assistant', content: answer, sources, abstention_reason: reason,
    response_kind: supportedAnswer ? 'grounded' : 'clarification', latency_ms: totalMs, origin: 'browser',
  });
  if (guidedMode && supportedAnswer) {
    const documentNames = [...new Set(sources.map((source) => source.title || source.source).filter(Boolean))];
    const result = getNudgeStore().create(callId, {
      type: 'knowledge_tip',
      text: documentNames.length
        ? `Grounded reply ready from ${documentNames.join(', ')}. Review it before using it in the conversation.`
        : 'A grounded reply is ready. Review it before using it in the conversation.',
      priority: 'MEDIUM',
      confidence: null,
      suggested_response: answer,
      context_query: query,
      sources,
      latency_ms: totalMs,
      expires_after_seconds: 180,
    });
    session.state.confidence = null;
    session.state.current_stage = 'awaiting_guidance';
    recordLatency({ call_id: callId, rag_ms: ragMs, total_ms: totalMs });
    emitLiveCallUpdate(session);
    if (result.created) io.emit('nudge', result.nudge);
    return {
      ...ragResponse.data,
      answer: null,
      sources,
      chunks: ragResponse.data.chunks || [],
      abstention_reason: null,
      response_kind: 'guided_suggestion',
      suggestion: result.nudge,
      call_id: callId,
      latency_ms: totalMs,
      session,
      escalation: null,
    };
  }
  session.turns.push(assistantTurn);
  // Retrieval scores are similarity values, not calibrated confidence probabilities.
  session.state.confidence = null;
  const escalation = activeEscalation(session) || null;
  session.state.current_stage = escalation ? 'escalation' : supportedAnswer ? 'answering' : 'needs_clarification';

  recordLatency({ call_id: callId, rag_ms: ragMs, total_ms: totalMs });
  emitTurn(callId, assistantTurn);
  feedToInsightsEngine(callId, 'assistant', answer).catch((err) => {
    logger.warn({ callId, err: err.message }, 'Live insights feed failed');
  });

  return {
    ...ragResponse.data,
    answer,
    sources,
    chunks: supportedAnswer ? (ragResponse.data.chunks || []) : [],
    abstention_reason: reason,
    response_kind: assistantTurn.response_kind,
    call_id: callId,
    latency_ms: totalMs,
    session,
    escalation,
  };
}

// ─── Vapi Standard Webhook ───────────────────────────────────
/**
 * POST /api/voice/webhook
 * Standard Vapi server URL handler.
 * Handles assistant-request, function-call, end-of-call-report
 */
router.post('/webhook', async (req, res) => {
  const body = req.body;
  const { message } = body;
  const type = message?.type || body.type;
  const call_id = message?.call?.id || body.call?.id || body.call_id || uuidv4();

  logger.info({ type, call_id }, '📞 Voice webhook received');

  // ── End-of-call report ──
  if (type === 'end-of-call-report') {
    finishSession(call_id);
    closeInsightsCall(call_id).catch(() => {});
    return res.status(200).json({ status: 'acknowledged' });
  }

  // ── Transcript event (real-time streaming to dashboard + Q4 nudge engine) ──
  if (type === 'transcript') {
    const { role, transcript, transcriptType } = message;
    if (transcriptType === 'final' && transcript?.trim()) {
      if (callHistory().get(call_id)?.status === 'completed') return res.status(200).json({ status: 'ignored', reason: 'Call has ended' });
      // Vapi role names vary by transport (customer/user and
      // assistant/agent/bot). Normalize once so both the session snapshot and
      // the Python detector receive a role they understand.
      const normalizedRole = role === 'customer' || role === 'user' ? 'user' : 'assistant';
      const session = getOrCreateSession(call_id);
      let turn = createTranscriptTurn(session, { role: normalizedRole, content: transcript, origin: 'vapi' });
      const previousTurn = session.turns.at(-1);
      const isDuplicate = previousTurn?.role === turn.role && previousTurn.content === turn.content;
      if (!isDuplicate) {
        session.turns.push(turn);
      } else {
        turn = previousTurn;
      }
      if (normalizedRole === 'user') {
        updateConversationState(session, transcript);
      }
      emitTurn(call_id, turn);

      // Both sides matter: customer turns drive buying/frustration cues and
      // agent turns allow the compliance detector to see quoted rates/fees.
      feedToInsightsEngine(call_id, normalizedRole, transcript).catch((err) => {
        logger.warn({ call_id, err: err.message }, 'Insights engine call failed');
      });
    }
    return res.status(200).json({ status: 'ok' });
  }

  // ── Status update events ──
  if (type === 'status-update') {
    io.emit('call:status', { call_id, status: message?.status });
    return res.status(200).json({ status: 'ok' });
  }

  // ── speech-update ──
  if (type === 'speech-update') {
    return res.status(200).json({ status: 'ok' });
  }

  res.status(200).json({ status: 'ok' });
});

// ─── Vapi Custom LLM Endpoint ────────────────────────────────
/**
 * POST /api/voice/vapi-llm
 * This acts as a Custom LLM endpoint that Vapi calls to get responses.
 * Vapi sends OpenAI-compatible chat completion format.
 * We use the last user message as the RAG query.
 */
router.post('/vapi-llm', async (req, res) => {
  const { messages, call } = req.body;
  const call_id = call?.id || uuidv4();
  const userMessages = messages?.filter((m) => m.role === 'user') || [];
  const lastUserMsg = String(userMessages[userMessages.length - 1]?.content || '').trim();
  const market = String(req.query.market || call?.metadata?.market || 'india-loan');
  const language = MARKET_LANGUAGES[market] || 'en-IN';

  logger.info({ call_id, query: lastUserMsg?.slice(0, 80) }, '🧠 Custom LLM query via RAG');

  if (!lastUserMsg || lastUserMsg.length > MAX_QUERY_LENGTH) {
    return writeSseResponse(res, 'I did not catch that. Could you please repeat your question?', true);
  }

  try {
    // Vapi normally emits a final transcript webhook first. Do not duplicate
    // that customer turn in the dashboard, but retain it when the webhook was
    // not configured (for example during an API-only test).
    const session = conversations.get(call_id);
    const alreadyRecorded = session?.turns.at(-1)?.role === 'user'
      && session.turns.at(-1)?.content === lastUserMsg;
    const result = await runVoiceTurn({
      callId: call_id,
      query: lastUserMsg,
      market,
      language,
      recordUser: !alreadyRecorded,
      emitUser: !alreadyRecorded,
    });
    logger.info({ call_id, latency_ms: result.latency_ms }, '✅ RAG response delivered');
    return writeSseResponse(res, result.answer);
  } catch (err) {
    logger.error({ call_id, err: err.message }, 'RAG call failed in vapi-llm');
    const fallback = err.code === 'CAPABILITY_PAUSED'
      ? 'This automated voice service is temporarily paused. Please ask a team member for assistance.'
      : "I'm sorry, I'm having trouble retrieving that information right now. Please ask a specialist for detailed assistance.";
    return writeSseResponse(res, fallback, true);
  }
});

function writeSseResponse(res, answer, finishImmediately = false) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const words = String(answer).split(/\s+/).filter(Boolean);
  let buffer = '';
  for (let index = 0; index < words.length; index += 1) {
    buffer += `${buffer ? ' ' : ''}${words[index]}`;
    if (finishImmediately || (index + 1) % 5 === 0 || /[.,!?;]/.test(words[index]) || index === words.length - 1) {
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${uuidv4()}`,
        object: 'chat.completion.chunk',
        choices: [{ delta: { content: buffer }, index: 0, finish_reason: null }],
      })}\n\n`);
      buffer = '';
    }
  }
  res.write(`data: ${JSON.stringify({
    id: `chatcmpl-${uuidv4()}`,
    object: 'chat.completion.chunk',
    choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
  })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

// ─── Session Management ──────────────────────────────────────

/**
 * POST /api/voice/query
 * Browser voice/text entry point. It owns a complete turn so the session,
 * RAG response, Socket.IO transcript, latency telemetry, and insight feed
 * cannot get out of sync.
 */
router.post('/query', async (req, res) => {
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  if (req.body.call_id !== undefined && (typeof req.body.call_id !== 'string' || !req.body.call_id.trim() || req.body.call_id.length > 200)) {
    return res.status(400).json({ error: 'Invalid call_id' });
  }
  if (!query || query.length > MAX_QUERY_LENGTH) {
    return res.status(400).json({ error: `query is required and must be under ${MAX_QUERY_LENGTH} characters` });
  }
  if (req.body.guided_mode !== undefined && typeof req.body.guided_mode !== 'boolean') {
    return res.status(400).json({ error: 'guided_mode must be a boolean' });
  }

  const callId = typeof req.body.call_id === 'string' && req.body.call_id.trim()
    ? req.body.call_id.trim()
    : uuidv4();
  const market = typeof req.body.market === 'string' ? req.body.market : 'india-loan';
  const language = typeof req.body.language === 'string' ? req.body.language : (MARKET_LANGUAGES[market] || 'en-IN');

  try {
    const result = await runVoiceTurn({ callId, query, market, language, guidedMode: req.body.guided_mode === true });
    return res.json(result);
  } catch (err) {
    const status = err.status || (err.code === 'ECONNABORTED' ? 504 : 503);
    logger.error({ callId, err: err.message, code: err.code }, 'Voice turn failed');
    return res.status(status).json({
      error: err.code === 'CAPABILITY_PAUSED' ? err.message : status === 409 ? err.message : status === 504 ? 'RAG request timed out' : 'RAG service is unavailable',
      message: err.code === 'CAPABILITY_PAUSED' ? err.message : status === 409 ? err.message : 'The voice service could not complete this turn. Check the RAG service health and try again.',
      ...(err.code && { code: err.code }),
      ...(err.control && { control: err.control }),
    });
  }
});

/**
 * POST /api/voice/session
 * Create a named call session
 */
router.post('/session', (req, res) => {
  const { call_id, language = 'en', market = 'india-loan', channel = 'voice' } = req.body;
  const id = call_id === undefined ? uuidv4() : call_id;
  if (typeof id !== 'string' || !id.trim() || id.length > 200) return res.status(400).json({ error: 'Invalid call_id' });
  if (!['voice', 'text'].includes(channel)) return res.status(400).json({ error: 'Invalid channel' });
  try {
    scopeForMarket(market);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const session = getOrCreateSession(id, { language, market, channel });
  emitLiveCallUpdate(session);
  logger.info({ call_id: id }, 'Session created');
  res.json({ call_id: id, session });
});

/**
 * GET /api/voice/session/:id
 */
router.get('/session/:id', (req, res) => {
  const session = conversations.get(req.params.id) || callHistory().get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

/**
 * GET /api/voice/session/:id/playbook
 * Return deterministic live workflow progress derived from persisted call evidence.
 */
router.get('/session/:id/playbook', (req, res) => {
  const session = conversations.get(req.params.id);
  if (!session || !isLive(session)) return res.status(404).json({ error: 'Active session not found' });
  const playbook = evaluatePlaybook(session);
  return res.json({
    call_id: session.call_id,
    playbook,
    reason: playbook ? null : 'No versioned playbook is available for this market.',
    evaluated_at: new Date().toISOString(),
  });
});

/**
 * GET /api/voice/session/:id/disclosure-checklist
 * Return conservative shadow-mode observations from the approved checklist that
 * was effective when this call began. Absence of a checklist is explicit.
 */
router.get('/session/:id/disclosure-checklist', (req, res) => {
  const session = conversations.get(req.params.id) || callHistory().get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const checklist = createDisclosureChecklistStore().evaluate(session);
  return res.json({
    call_id: session.call_id,
    checklist,
    reason: checklist ? null : 'No approved, effective checklist applies to this market and channel.',
    evaluated_at: new Date().toISOString(),
  });
});

/**
 * POST /api/voice/session/:id/disclosure-checklist/items/:itemId/confirm
 * Record an attributed human decision without rewriting detector evidence.
 */
router.post('/session/:id/disclosure-checklist/items/:itemId/confirm', (req, res) => {
  const session = conversations.get(req.params.id);
  if (!session || !isLive(session)) return res.status(404).json({ error: 'Active session not found' });
  const checklist = createDisclosureChecklistStore().confirm(
    session,
    req.params.itemId,
    req.session.userId,
    req.body,
  );
  return res.json({ call_id: session.call_id, checklist });
});

/**
 * GET /api/voice/live
 * Current in-progress calls for the Insights page. This snapshot makes the
 * dashboard reliable when it is opened after Voice Studio has already emitted
 * transcript events, or after a temporary Socket.IO reconnect.
 */
router.get('/live', (_req, res) => {
  const calls = [...conversations.values()]
    .filter(isLive)
    .sort((left, right) => new Date(right.last_activity) - new Date(left.last_activity))
    .map(buildLiveCall);
  res.json({ calls, timestamp: new Date().toISOString() });
});

/**
 * POST /api/voice/session/:id/end
 * End browser-owned sessions and release both conversation and insights state.
 */
router.post('/session/:id/end', (req, res) => {
  const session = finishSession(req.params.id);
  closeInsightsCall(req.params.id).catch(() => {});
  return res.json({ status: 'ended', call_id: req.params.id, existed: Boolean(session) });
});

/**
 * POST /api/voice/session/:id/guidance/query
 * Run a private operator knowledge search. The question and result stay outside
 * the customer transcript until an operator explicitly applies the resulting tip.
 */
router.post('/session/:id/guidance/query', async (req, res) => {
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  if (!query || query.length > MAX_QUERY_LENGTH) {
    return res.status(400).json({ error: `query is required and must be under ${MAX_QUERY_LENGTH} characters` });
  }
  const session = conversations.get(req.params.id);
  if (!session || !isLive(session)) return res.status(404).json({ error: 'Active session not found' });
  if (activeEscalation(session)) return res.status(409).json({ error: 'Resolve the human handoff before requesting automated guidance' });
  assertOperationalControl('private_guidance');
  if (pendingTurns.has(session.call_id)) return res.status(409).json({ error: 'A turn is already in progress for this call.' });

  pendingTurns.add(session.call_id);
  const startedAt = Date.now();
  try {
    const ragScope = scopeForMarket(session.market);
    const ragResponse = await axios.post(
      `${getRagUrl()}/retrieve`,
      { query, top_k: 2, session_id: session.call_id, market: ragScope.market, product: ragScope.product, language: session.language },
      { timeout: Number(process.env.RAG_REQUEST_TIMEOUT_MS || 10_000) }
    );
    if (!isLive(session)) return res.status(409).json({ error: 'This call has ended.' });
    const supported = Boolean(ragResponse.data.sources?.length && !ragResponse.data.abstention_reason && ragResponse.data.answer);
    const latencyMs = Date.now() - startedAt;
    recordLatency({ call_id: session.call_id, rag_ms: latencyMs, total_ms: latencyMs, operator_guidance: true });
    if (!supported) {
      return res.json({
        call_id: session.call_id,
        response_kind: 'guidance_abstention',
        suggestion: null,
        abstention_reason: ragResponse.data.abstention_reason || 'insufficient_support',
        message: 'No approved knowledge supports that private question. Rephrase it or request human assistance.',
        latency_ms: latencyMs,
      });
    }
    const sources = ragResponse.data.sources;
    const documentNames = [...new Set(sources.map((source) => source.title || source.source).filter(Boolean))];
    const result = getNudgeStore().create(session.call_id, {
      type: 'knowledge_tip',
      text: documentNames.length
        ? `Private guidance ready from ${documentNames.join(', ')}.`
        : 'Private grounded guidance is ready.',
      priority: 'MEDIUM',
      confidence: null,
      suggested_response: ragResponse.data.answer,
      context_query: query,
      sources,
      origin: 'operator_query',
      requested_by: req.session.userId,
      latency_ms: latencyMs,
      expires_after_seconds: 180,
    });
    session.state.current_stage = 'awaiting_guidance';
    emitLiveCallUpdate(session);
    if (result.created) io.emit('nudge', result.nudge);
    return res.json({
      call_id: session.call_id,
      response_kind: 'guided_suggestion',
      suggestion: result.nudge,
      sources,
      latency_ms: latencyMs,
    });
  } catch (error) {
    const status = error.status || (error.code === 'ECONNABORTED' ? 504 : 503);
    logger.error({ call_id: session.call_id, err: error.message, code: error.code }, 'Private guidance query failed');
    return res.status(status).json({
      error: status === 409 ? error.message : status === 504 ? 'RAG request timed out' : 'RAG service is unavailable',
    });
  } finally {
    pendingTurns.delete(session.call_id);
  }
});

/**
 * POST /api/voice/session/:id/nudges/:nudgeId/apply
 * Commit a reviewed grounded tip as the next assistant turn. Replays return the
 * original turn, while expired, dismissed, cross-call, and handoff-paused tips fail.
 */
router.post('/session/:id/nudges/:nudgeId/apply', (req, res) => {
  const responseText = req.body?.response_text;
  if (responseText !== undefined && (typeof responseText !== 'string' || !responseText.trim() || responseText.trim().length > MAX_QUERY_LENGTH)) {
    return res.status(400).json({ error: `response_text must be between 1 and ${MAX_QUERY_LENGTH} characters` });
  }
  const session = conversations.get(req.params.id);
  if (!session || !isLive(session)) return res.status(404).json({ error: 'Active session not found' });
  if (activeEscalation(session)) return res.status(409).json({ error: 'Resolve the human handoff before applying an automated tip' });
  const store = getNudgeStore();
  const current = store.get(req.params.nudgeId);
  if (!current) return res.status(404).json({ error: 'Nudge not found' });
  if (current.call_id !== session.call_id) return res.status(409).json({ error: 'Nudge does not belong to this call' });
  const priorTurn = session.turns.find((turn) => turn.guided_by_nudge_id === current.id);
  if (current.status === 'applied' && priorTurn) {
    return res.json({ answer: priorTurn.content, sources: priorTurn.sources || [], turn: priorTurn, nudge: current, replayed: true });
  }
  if (current.status === 'applied') return res.status(409).json({ error: 'Applied nudge is missing its recorded turn' });
  assertOperationalControl('guided_delivery');

  let appended = false;
  let turn;
  try {
    const result = store.apply(current.id, req.session.userId, { responseText }, (nudge, appliedResponse) => {
      turn = createTranscriptTurn(session, {
        role: 'assistant',
        content: appliedResponse,
        sources: nudge.sources || [],
        response_kind: 'guided',
        guided_by_nudge_id: nudge.id,
        guided_by_user_id: req.session.userId,
        guided_was_edited: appliedResponse !== nudge.suggested_response,
        guided_original_response: appliedResponse !== nudge.suggested_response ? nudge.suggested_response : undefined,
        origin: 'guided_review',
      });
      session.turns.push(turn);
      appended = true;
      session.state.current_stage = 'answering';
      session.last_activity = turn.ts;
      callHistory().save(session);
    });
    io.emit('nudge:updated', { nudge: result.nudge });
    emitTurn(session.call_id, turn);
    feedToInsightsEngine(session.call_id, 'assistant', turn.content).catch((error) => {
      logger.warn({ call_id: session.call_id, err: error.message }, 'Guided reply insights feed failed');
    });
    return res.json({ answer: turn.content, sources: turn.sources, turn, nudge: result.nudge, replayed: false });
  } catch (error) {
    if (appended && session.turns.at(-1) === turn) session.turns.pop();
    throw error;
  }
});

router.get('/history', (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  const offset = Number(req.query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
    return res.status(400).json({ error: 'limit must be 1-100 and offset must be a nonnegative integer' });
  }
  res.json(callHistory().list({ limit, offset }));
});

/**
 * GET /api/voice/history/:id/summary
 * Return the latest structured summary and every immutable prior version. A
 * deterministic draft is created lazily for calls archived by older releases.
 */
router.get('/history/:id/summary', (req, res) => {
  const session = callHistory().get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Call not found' });
  if (session.status !== 'completed') return res.status(409).json({ error: 'The call is still active' });
  getCallSummaryStore().ensureDraft(session);
  return res.json(getCallSummaryStore().getForCall(session.call_id));
});

/**
 * POST /api/voice/history/:id/summary/:summaryId/revise
 * Create a new operator-authored draft without mutating its source version.
 */
router.post('/history/:id/summary/:summaryId/revise', (req, res) => {
  const session = callHistory().get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Call not found' });
  if (session.status !== 'completed') return res.status(409).json({ error: 'The call is still active' });
  const summary = getCallSummaryStore().revise(
    session,
    req.params.summaryId,
    req.session.userId,
    req.body,
  );
  return res.status(201).json({ summary });
});

/**
 * POST /api/voice/history/:id/summary/:summaryId/accept
 * Accept only the latest draft. Replays are idempotent and accepted versions
 * cannot be replaced by a delayed generation callback.
 */
router.post('/history/:id/summary/:summaryId/accept', (req, res) => {
  const session = callHistory().get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Call not found' });
  const summary = getCallSummaryStore().accept(session.call_id, req.params.summaryId, req.session.userId);
  return res.json({ summary });
});

/**
 * GET /api/voice/latency
 * Last 50 latency records
 */
router.get('/latency', (req, res) => {
  res.json(latencyHistory.slice(-50));
});

/**
 * POST /api/voice/escalate
 */
router.post('/escalate', (req, res) => {
  const { call_id, reason } = req.body;
  if (typeof call_id !== 'string' || (reason !== undefined && (typeof reason !== 'string' || reason.length > 1000))) {
    return res.status(400).json({ error: 'A call_id and a reason of at most 1000 characters are required' });
  }
  const session = conversations.get(call_id);
  if (!session) return res.status(404).json({ error: 'Active session not found' });
  const escalation = requestEscalation(session, reason?.trim() || 'Customer requested human agent');
  res.json(escalation);
});

// ── Q4 Real-Time Insights Integration ────────────────────────
/**
 * feedToInsightsEngine — sends a transcript chunk to the Python
 * realtime-insights service (port 8003) for signal detection + nudge generation.
 * This is fire-and-forget with graceful degradation; nudges are emitted back
 * to the dashboard via Socket.IO once they're generated.
 */
async function feedToInsightsEngine(call_id, speaker, text) {
  const insightsUrl = (process.env.INSIGHTS_SERVICE_URL || process.env.REALTIME_AI_URL || 'http://localhost:8003').replace(/\/+$/, '');
  try {
    const response = await axios.post(
      `${insightsUrl}/detect-signals`,
      { call_id, speaker, text },
      { timeout: 2000 }
    );
    if (response.data?.nudges && response.data.nudges.length > 0) {
      if (!isOperationalControlEnabled('proactive_nudges')) return;
      for (const nudge of response.data.nudges) {
        const session = conversations.get(call_id);
        if (!session || !isLive(session)) continue;
        if (session && isLive(session)) {
          session.state.last_nudge = {
            type: nudge.signal_type,
            priority: nudge.priority,
            text: nudge.text,
            confidence: nudge.confidence,
          };
          if (nudge.signal_type === 'human_escalation') {
            session.state.compliance_risk = true;
            session.state.compliance_rule = 'SUPERVISOR_ESCALATION_REQUESTED';
            session.state.frustration_level = Math.max(session.state.frustration_level, 0.7);
          } else if (nudge.signal_type === 'compliance_gap') {
            session.state.compliance_risk = true;
            session.state.compliance_rule = 'DISCLOSURE_NOT_GIVEN';
          } else if (nudge.signal_type === 'rising_frustration') {
            session.state.frustration_level = Math.max(session.state.frustration_level, 0.5);
          }
          session.last_activity = new Date().toISOString();
          emitLiveCallUpdate(session);
        }
        let result;
        try { result = getNudgeStore().create(call_id, {
          type: nudge.signal_type,
          priority: nudge.priority,
          text: nudge.text,
          confidence: nudge.confidence,
          latency_ms: nudge.end_to_end_latency_ms_excl_asr || 0,
          expires_after_seconds: nudge.expires_after_seconds || 45,
        }); } catch (error) {
          if (error.status === 409) continue;
          throw error;
        }
        if (result.created) io.emit('nudge', result.nudge);
      }
    }
  } catch (err) {
    logger.warn({ call_id, error: err.message }, 'Live nudge processing unavailable');
  }
}

async function closeInsightsCall(callId) {
  const insightsUrl = (process.env.INSIGHTS_SERVICE_URL || process.env.REALTIME_AI_URL || 'http://localhost:8003').replace(/\/+$/, '');
  await axios.delete(`${insightsUrl}/calls/${encodeURIComponent(callId)}`, { timeout: 2_000 });
}

// ── Helpers ──────────────────────────────────────────────────

function createSession(call_id, overrides = {}) {
  const startedAt = new Date().toISOString();
  return {
    call_id,
    workspace_id: 'default',
    created_at: startedAt,
    started_at: startedAt,
    language: overrides.language || 'en',
    market: overrides.market || 'india-loan',
    channel: overrides.channel || 'voice',
    turns: [],
    escalations: [],
    state: {
      customer_name: null,
      intent: null,
      qualification_status: 'unknown',
      income: null,
      loan_amount: null,
      current_stage: 'greeting',
      confidence: null,
      frustration_level: 0,
      compliance_risk: false,
      compliance_rule: 'NONE',
      last_nudge: null,
      missing_fields: [],
    },
    status: 'created',
    last_activity: startedAt,
  };
}

function createTranscriptTurn(session, fields, observedAt = new Date()) {
  const observedAtMs = observedAt.getTime();
  const sessionStartedAt = Date.parse(session.started_at || session.created_at || '');
  return {
    ...fields,
    ts: observedAt.toISOString(),
    sequence: (session.turns?.length || 0) + 1,
    elapsed_ms: Number.isFinite(sessionStartedAt) ? Math.max(0, observedAtMs - sessionStartedAt) : null,
  };
}

function buildSummary(session) {
  if (!session.turns || session.turns.length === 0) return 'No conversation recorded.';
  return session.turns
    .slice(-4)
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join('\n');
}

export default router;
