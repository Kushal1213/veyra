import React, { useCallback, useEffect, useState } from 'react';
import { Check, FilePenLine, Link2, Save, X } from 'lucide-react';

import { LoadingState, StatusBadge } from './WorkspaceUI';

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'The summary request could not be completed.');
  return body;
}

function evidenceLabel(evidence) {
  if (evidence.kind === 'citation') {
    return evidence.page
      ? `${evidence.title || 'Source'} · page ${evidence.page}`
      : evidence.title || 'Knowledge source';
  }
  return `Turn ${evidence.turn_index + 1}`;
}

function EvidenceLinks({ evidence = [], onNavigateEvidence }) {
  if (evidence.length === 0) return <span className="text-[10px] text-muted">No direct transcript link</span>;
  return (
    <div className="flex flex-wrap gap-2 mt-2" aria-label="Supporting evidence">
      {evidence.map((entry, index) => (
        <button
          type="button"
          className="text-action !text-[10px]"
          key={`${entry.kind}-${entry.turn_index}-${entry.source_index ?? index}`}
          onClick={() => onNavigateEvidence(entry.turn_index, entry.source_index)}
        >
          <Link2 size={11} aria-hidden="true" />
          {evidenceLabel(entry)}
        </button>
      ))}
    </div>
  );
}

function initialForm(summary) {
  return {
    sections: Object.fromEntries(
      (summary.sections || []).map((section) => [
        section.id,
        section.items.map((entry) => entry.text).join('\n'),
      ]),
    ),
    follow_up_actions: (summary.follow_up_actions || []).map((entry) => entry.text).join('\n'),
  };
}

export default function CallSummaryReview({ callId, onNavigateEvidence }) {
  const [data, setData] = useState({ latest: null, versions: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ sections: {}, follow_up_actions: '' });
  const [error, setError] = useState('');

  const loadSummary = useCallback(async (signal) => {
    setLoading(true);
    setError('');
    try {
      const result = await requestJson(`/api/voice/history/${encodeURIComponent(callId)}/summary`, { signal });
      setData(result);
    } catch (requestError) {
      if (requestError.name !== 'AbortError') setError(requestError.message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [callId]);

  useEffect(() => {
    const controller = new AbortController();
    loadSummary(controller.signal);
    return () => controller.abort();
  }, [loadSummary]);

  const startEditing = () => {
    setForm(initialForm(data.latest));
    setEditing(true);
    setError('');
  };

  const submitRevision = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await requestJson(
        `/api/voice/history/${encodeURIComponent(callId)}/summary/${encodeURIComponent(data.latest.id)}/revise`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sections: form.sections,
            follow_up_actions: form.follow_up_actions
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean),
          }),
        },
      );
      setEditing(false);
      await loadSummary();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const acceptSummary = async () => {
    setBusy(true);
    setError('');
    try {
      await requestJson(
        `/api/voice/history/${encodeURIComponent(callId)}/summary/${encodeURIComponent(data.latest.id)}/accept`,
        { method: 'POST' },
      );
      await loadSummary();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <section className="panel" aria-label="After-call summary">
        <LoadingState label="Preparing evidence-linked summary" rows={3} />
      </section>
    );
  }

  const summary = data.latest;
  return (
    <section className="panel" aria-labelledby="call-summary-title">
      <div className="panel-header">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="call-summary-title" className="panel-title">After-call summary</h2>
            {summary && (
              <StatusBadge tone={summary.state === 'accepted' ? 'success' : 'warning'}>
                {summary.state}
              </StatusBadge>
            )}
          </div>
          <p className="panel-description">
            Evidence-linked draft for operator review. Generated wording is not treated as a verified fact until accepted.
          </p>
        </div>
        {summary && !editing && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn" onClick={startEditing} disabled={busy}>
              <FilePenLine size={14} aria-hidden="true" />
              {summary.state === 'accepted' ? 'Create revision' : 'Edit draft'}
            </button>
            {summary.state === 'draft' && (
              <button type="button" className="btn btn-primary" onClick={acceptSummary} disabled={busy}>
                <Check size={14} aria-hidden="true" />
                Accept summary
              </button>
            )}
          </div>
        )}
      </div>

      {error && <p className="notice notice-error mb-5" role="alert">{error}</p>}
      {!summary && !error && <p className="text-sm text-muted">No summary is available for this call.</p>}

      {summary && editing ? (
        <form className="space-y-5" onSubmit={submitRevision}>
          <p className="notice notice-warning">
            Saving creates version {summary.version + 1}. Version {summary.version} remains unchanged in the audit history.
          </p>
          <div className="grid md:grid-cols-2 gap-5">
            {summary.sections.map((section) => (
              <label key={section.id} className="block space-y-2 text-xs font-semibold">
                <span>{section.title}</span>
                <textarea
                  rows={4}
                  maxLength={4_000}
                  value={form.sections[section.id] || ''}
                  onChange={(event) => setForm((current) => ({
                    ...current,
                    sections: { ...current.sections, [section.id]: event.target.value },
                  }))}
                  aria-describedby={`${section.id}-help`}
                />
                <span id={`${section.id}-help`} className="block text-[10px] text-muted font-normal">
                  Put each separate summary item on its own line. Existing evidence links are retained.
                </span>
              </label>
            ))}
          </div>
          <label className="block space-y-2 text-xs font-semibold">
            <span>Structured follow-up actions</span>
            <textarea
              rows={4}
              maxLength={10_000}
              value={form.follow_up_actions}
              onChange={(event) => setForm((current) => ({ ...current, follow_up_actions: event.target.value }))}
              aria-describedby="follow-up-help"
            />
            <span id="follow-up-help" className="block text-[10px] text-muted font-normal">
              One action per line, up to 10 actions.
            </span>
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn" disabled={busy} onClick={() => setEditing(false)}>
              <X size={14} aria-hidden="true" /> Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              <Save size={14} aria-hidden="true" /> {busy ? 'Saving…' : 'Save new version'}
            </button>
          </div>
        </form>
      ) : summary ? (
        <>
          <div className="grid lg:grid-cols-2 gap-x-8 gap-y-6">
            {summary.sections.map((section) => (
              <section key={section.id} aria-labelledby={`summary-${section.id}`}>
                <h3 id={`summary-${section.id}`} className="text-xs font-semibold">{section.title}</h3>
                {section.items.length === 0 ? (
                  <p className="text-xs text-muted mt-2">
                    {section.id === 'conversation_quality' ? 'No deterministic review signal was detected.' : 'Nothing recorded.'}
                  </p>
                ) : (
                  <ul className="space-y-3 mt-2">
                    {section.items.map((entry) => (
                      <li key={entry.id} className="text-xs leading-6 border-l-2 border-[var(--line)] pl-3">
                        <p>{entry.text}</p>
                        <EvidenceLinks evidence={entry.evidence} onNavigateEvidence={onNavigateEvidence} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>

          <div className="mt-7 pt-6 border-t border-[var(--line)]">
            <h3 className="text-xs font-semibold">Follow-up actions</h3>
            {summary.follow_up_actions.length === 0 ? (
              <p className="text-xs text-muted mt-2">No follow-up action proposed.</p>
            ) : (
              <ol className="space-y-3 mt-3">
                {summary.follow_up_actions.map((action, index) => (
                  <li key={action.id} className="text-xs leading-6">
                    <span className="font-semibold mr-2">{index + 1}.</span>{action.text}
                    <EvidenceLinks evidence={action.evidence} onNavigateEvidence={onNavigateEvidence} />
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="mt-7 pt-5 border-t border-[var(--line)] flex flex-wrap items-center justify-between gap-3 text-[10px] text-muted">
            <span>
              Version {summary.version} of {data.versions.length} · {summary.generator === 'operator_edit' ? 'Operator revision' : 'Deterministic fallback'}
            </span>
            <span>
              {summary.state === 'accepted'
                ? `Accepted ${new Date(summary.accepted_at).toLocaleString()}`
                : `Created ${new Date(summary.created_at).toLocaleString()}`}
            </span>
          </div>
          {data.versions.length > 1 && (
            <details className="source-detail mt-4">
              <summary>{data.versions.length - 1} preserved prior version{data.versions.length === 2 ? '' : 's'}</summary>
              <ul className="mt-3 space-y-2 text-xs text-muted">
                {data.versions.slice(1).map((version) => (
                  <li key={version.id}>
                    Version {version.version} · {version.state} · {version.generator === 'operator_edit' ? 'operator revision' : 'deterministic fallback'}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      ) : null}
    </section>
  );
}
