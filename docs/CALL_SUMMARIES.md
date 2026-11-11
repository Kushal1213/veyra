# Evidence-Linked After-Call Summaries

Completed calls receive a structured summary draft without changing the archived
call snapshot. The draft is a review aid: it is visibly marked as unaccepted until
an authenticated operator accepts it.

## Summary lifecycle

1. Ending a call saves the completed call first.
2. The gateway creates a deterministic fallback draft from the saved transcript,
   call state, citations, and handoff record. A generation failure is logged and
   cannot prevent call archival.
3. Calls completed by an older release receive the same draft lazily when their
   summary endpoint is first opened.
4. Editing creates a new `operator_edit` version. It never overwrites the source
   version, and both sides receive append-only audit events.
5. Only the latest draft can be accepted. Repeating acceptance is idempotent.
   An accepted version remains immutable; a later edit creates another draft.

The deterministic generator is deliberately extractive. It does not call a model,
make a compliance decision, assign a quality score, or claim that a proposed follow-up was completed.
Follow-up actions use the `proposed` state until a future workflow explicitly owns
execution and completion.

## Conversation recovery signals

The fallback draft also looks for explicit customer requests to repeat or clarify
something in the supported English, Taglish, and Bahasa patterns. When it finds one, it links the request and the next recorded agent turn,
then labels the result as a review signal—not a conclusion about quality or whether
the customer was satisfied. This makes the signal safe to use as a QA shortcut while
leaving the decision with the reviewer. No signal is shown when no such cue is found.

Every new transcript turn is ordered (`sequence`) and includes elapsed milliseconds
from the call's `started_at` time. This is provider-neutral metadata for reconstructing
the call; it is reception timing, not a claim about the precise timing of remote audio.

## Evidence model

Every generated factual item links to its supporting zero-based transcript turn.
Items derived from a grounded assistant response also retain safe citation identity:
document ID, revision, chunk ID, PDF page, and the source's index within that turn.
The review UI displays human-readable one-based turn numbers and scrolls/focuses the
selected transcript entry.

Operator edits retain the source section's evidence links. This preserves navigation
but does not assert that newly written wording is supported by that evidence. Evidence
re-attachment and sentence-level support checks remain evaluation work.

## Storage

`call_summaries` stores version, state, generator, input hash, author, timestamps,
and the structured payload. `(call_id, version)` is unique. `call_summary_events`
stores generation, revision, and acceptance events with actor attribution where
applicable. Calls and summary versions share the installation workspace boundary.

The input hash covers the completed call ID, end time, outcome, state, turns, and
escalations. The fallback generator reuses an existing version for the same input
snapshot. No raw provider prompt or external provider response exists in this slice.

## API

| Endpoint | Behavior |
|---|---|
| `GET /api/voice/history/:id/summary` | Ensure and return `latest` plus all versions newest first |
| `POST /api/voice/history/:id/summary/:summaryId/revise` | Create a new draft from editable sections and proposed follow-ups |
| `POST /api/voice/history/:id/summary/:summaryId/accept` | Accept the latest draft idempotently |

Revision input accepts a `sections` object keyed by the known section IDs and up to
10 follow-up actions. The server preserves evidence from the source version rather
than accepting evidence references from the browser.

## Deliberate limits

- Model/provider generation, asynchronous jobs, retry controls, usage accounting,
  and provider callbacks are not included yet.
- Accuracy, completeness, acceptance-rate, edit-distance, and latency evaluation
  require a customer-reviewed call set before this feature can be called validated.
- Follow-up actions are structured proposals, not CRM tasks or proof of customer contact.
- Provider-free lifecycle coverage passed on 2026-10-07 for deterministic generation,
  replay stability, evidence-preserving revision, latest-only acceptance, and idempotent
  acceptance. Isolated browser verification also exercised the after-call summary and
  its mobile layout. Live-provider quality and customer-reviewed accuracy remain open.
