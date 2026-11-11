# Provider readiness inventory

Veyra includes a local provider and dependency inventory command for the P0-B
readiness gate. It reads source files, `package.json` manifests, and
`services/requirements.txt`, then emits a JSON report without reading `.env` or
printing secret values.

Run from the repository root:

```powershell
npm run readiness:providers
```

To write a review artifact:

```powershell
npm run readiness:providers -- --output evaluation/provider_inventory.json
```

To include a live `npm audit --json` summary:

```powershell
npm run readiness:providers -- --audit
```

The report currently covers:

- Gemini API usage in RAG and ingestion, including configured model IDs and the
  maintained `google-genai` package pin.
- Vapi browser SDK and gateway voice configuration.
- Deepgram model references used through Vapi.
- Node engine expectations, Python dependency pinning, and optional npm audit
  counts.

The command deliberately marks live provider smoke tests as `not_run`. Those
tests require an authorized provider account, budget, and synthetic data plan.
This inventory is a starting point for remediation and signoff; it does not
establish provider availability, pricing, security terms, or production voice
quality.

Current expected findings:

- The Python services use the maintained Google Gen AI SDK through a focused
  adapter. Contract tests cover embedding request shape, 3,072-dimensional
  output configuration, generation settings, missing configuration, and client
  lifecycle. The embedding model and dimension were intentionally unchanged.
- The local demo uses browser speech and keeps Vapi disabled. Vapi is fail-closed until `PUBLIC_WEBHOOK_URL` is a public HTTPS endpoint, `VOICE_SERVICE_TOKEN` is set, and both Vapi credential IDs are configured. Saved assistants use authenticated `server` callbacks rather than legacy `serverUrl` fields.
  Its configured model is Veyra's custom grounded endpoint, never a provider-hosted
  fallback model.
