import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  History,
  RefreshCw,
} from 'lucide-react';
import NudgeFeed from '../components/NudgeFeed';
import CallSummaryReview from '../components/CallSummaryReview';
import QAReviewPanel from '../components/QAReviewPanel';
import { MARKET_LABELS } from '../components/AnalyticsShared';
import {
  EmptyState,
  LoadingState,
  PageHeading,
  StatusBadge,
} from '../components/WorkspaceUI';

const PAGE_SIZE = 20;
const buttonClass = 'btn';

function formatElapsed(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

async function readJson(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new Error('Call history is unavailable. Please try again.');
  return response.json();
}

export default function CallHistoryPage({ selectedId = null, onSelectCall }) {
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const setSelectedId = onSelectCall;
  const [data, setData] = useState({ calls: [], total: 0 });
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const navigateToEvidence = useCallback((turnIndex, sourceIndex) => {
    const source = Number.isInteger(sourceIndex)
      ? document.getElementById(`call-source-${turnIndex}-${sourceIndex}`)
      : null;
    if (source) source.open = true;
    const target = source || document.getElementById(`call-turn-${turnIndex}`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const focusTarget = source?.querySelector('summary') || target;
    focusTarget.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setSession(null);
    const url = selectedId
      ? `/api/voice/session/${encodeURIComponent(selectedId)}`
      : `/api/voice/history?limit=${PAGE_SIZE}&offset=${offset}`;
    readJson(url, controller.signal)
      .then((result) => (selectedId ? setSession(result) : setData(result)))
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [offset, revision, selectedId]);

  return (
    <section className="page">
      <PageHeading
        eyebrow="Every conversation has a story"
        title={selectedId ? 'Call Review' : 'Call History'}
        description={
          selectedId
            ? 'Revisit the exchange, inspect its sources, and review what happened next.'
            : 'Find completed conversations and the evidence behind every response.'
        }
        actions={
          <button
            className="btn"
            aria-label="Refresh"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        }
      >
        {selectedId && (
          <button
            className="icon-button"
            aria-label="Back to call history"
            onClick={() => setSelectedId(null)}
          >
            <ArrowLeft size={18} />
          </button>
        )}
      </PageHeading>
      {loading && (
        <div className="panel">
          <LoadingState label="Loading calls" rows={4} />
        </div>
      )}
      {error && (
        <p role="alert" className="notice notice-error">
          {error} Use Refresh to try again.
        </p>
      )}
      {!loading && !error && !selectedId && (
        <>
          {data.calls.length === 0 ? (
            <div className="panel">
              <EmptyState icon={History} title="A record of every conversation">
                Completed sessions appear here with their transcript, citations,
                and handoff requests. End a session in Voice Studio to save it
                for review.
              </EmptyState>
            </div>
          ) : (
            <div className="data-table">
              <table>
                <caption className="sr-only">Completed workspace calls</caption>
                <thead>
                  <tr>
                    {[
                      'Conversation',
                      'Agent / market',
                      'Ended',
                      'Outcome',
                      'Turns',
                    ].map((title) => (
                      <th key={title} scope="col">
                        {title}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.calls.map((call) => (
                    <tr key={call.call_id}>
                      <td>
                        <button
                          className="text-action text-left break-all max-w-60"
                          onClick={() => setSelectedId(call.call_id)}
                        >
                          {call.call_id}
                        </button>
                      </td>
                      <td className="whitespace-nowrap">
                        {MARKET_LABELS[call.market] || call.market}
                      </td>
                      <td className="whitespace-nowrap text-muted">
                        {new Date(call.ended_at).toLocaleString()}
                      </td>
                      <td>
                        <StatusBadge
                          tone={
                            call.outcome === 'human_handoff_requested'
                              ? 'warning'
                              : 'neutral'
                          }
                        >
                          {call.outcome === 'human_handoff_requested'
                            ? 'Handoff requested'
                            : 'Completed'}
                        </StatusBadge>
                      </td>
                      <td className="tabular-nums">{call.turn_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex justify-between items-center gap-4 text-[11px] text-muted">
            <span>{data.total} completed calls</span>
            <div className="flex items-center gap-3">
              <button
                className={buttonClass}
                aria-label="Previous page"
                disabled={offset === 0}
                onClick={() =>
                  setOffset((value) => Math.max(0, value - PAGE_SIZE))
                }
              >
                <ChevronLeft size={15} />
              </button>
              <span>Page {Math.floor(offset / PAGE_SIZE) + 1}</span>
              <button
                className={buttonClass}
                aria-label="Next page"
                disabled={offset + PAGE_SIZE >= data.total}
                onClick={() => setOffset((value) => value + PAGE_SIZE)}
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
        </>
      )}
      {!loading && !error && session && (
        <>
          <dl className="metrics-strip stats-three">
            <div className="metric">
              <dt className="metric-label">Call ID</dt>
              <dd className="text-xs break-all mt-3 font-mono">
                {session.call_id}
              </dd>
            </div>
            <div className="metric">
              <dt className="metric-label">Agent / market</dt>
              <dd className="text-sm mt-3">
                {MARKET_LABELS[session.market] || session.market}
              </dd>
            </div>
            <div className="metric">
              <dt className="metric-label">Session status</dt>
              <dd className="mt-3">
                <StatusBadge>{session.status}</StatusBadge>
              </dd>
            </div>
          </dl>
          {session.escalations?.map((escalation) => (
            <div
              key={escalation.escalation_id}
              className="notice notice-warning"
            >
              <h2 className="font-semibold">{escalation.resolved_at ? 'Previous automatic handoff resolved' : 'Human handoff requested'}</h2>
              <p className="mt-2">{escalation.reason}</p>
              {escalation.resolved_at && <p className="mt-2">{escalation.resolution}</p>}
              <p className="text-xs mt-2">
                Priority: {escalation.priority} · Transfer is not confirmed by
                this record.
              </p>
              {escalation.missing_information?.length > 0 && (
                <p className="mt-2">
                  Missing details: {escalation.missing_information.join(', ')}
                </p>
              )}
            </div>
          ))}
          <QAReviewPanel
            callId={session.call_id}
            turns={session.turns}
            onNavigateEvidence={navigateToEvidence}
          />
          <CallSummaryReview
            key={session.call_id}
            callId={session.call_id}
            onNavigateEvidence={navigateToEvidence}
          />
          <div className="grid xl:grid-cols-[minmax(0,1.55fr)_minmax(280px,1fr)] gap-5 items-start">
            <section className="panel" aria-label="Saved transcript">
              <div className="panel-header">
                <h2 className="panel-title">Transcript</h2>
                <span className="text-[10px] text-muted">
                  {session.turns.length} turns
                </span>
              </div>
              {session.turns.length === 0 && (
                <EmptyState compact title="No transcript recorded">
                  This session has no saved turns.
                </EmptyState>
              )}
              <div className="space-y-7">
                {session.turns.map((turn, index) => (
                  <article
                    key={index}
                    id={`call-turn-${index}`}
                    tabIndex={-1}
                    className="min-w-0 focus:outline-2 focus:outline-offset-4 focus:outline-[var(--accent)]"
                  >
                    <div className="message-meta justify-between">
                      <strong>
                        {turn.role === 'user' ? 'Customer' : 'Agent'}
                      </strong>
                      <div className="flex items-center gap-2">
                        {turn.sequence && <span>#{turn.sequence}</span>}
                        {formatElapsed(turn.elapsed_ms) && <span>+{formatElapsed(turn.elapsed_ms)}</span>}
                        <time>{new Date(turn.ts).toLocaleTimeString()}</time>
                      </div>
                    </div>
                    <p className="message-content text-[13px] leading-7">
                      {turn.content}
                    </p>
                    {turn.sources?.map((source, sourceIndex) => (
                      <details
                        key={sourceIndex}
                        id={`call-source-${index}-${sourceIndex}`}
                        className="source-detail"
                      >
                        <summary tabIndex={-1}>
                          {source.title || source.source || 'Knowledge source'}
                          {source.revision
                            ? ` · Revision ${source.revision}`
                            : ''}
                        </summary>
                        <div className="mt-3 space-y-2 text-muted">
                          {source.document_id && (
                            <p className="text-[10px] break-all">
                              Document {source.document_id}
                            </p>
                          )}
                          {source.page && <p>PDF page {source.page}</p>}
                          {source.chunk_id && (
                            <p className="text-[10px] font-mono break-all">
                              {source.chunk_id}
                            </p>
                          )}
                          {source.excerpt && (
                            <p className="whitespace-pre-wrap">
                              {source.excerpt}
                            </p>
                          )}
                        </div>
                      </details>
                    ))}
                  </article>
                ))}
              </div>
            </section>
            <aside className="panel" aria-label="Recorded operator nudges">
              <NudgeFeed callId={session.call_id} review />
            </aside>
          </div>
        </>
      )}
    </section>
  );
}
