# Live Voice Demo Runbook

Use this flow to present Veyra as a voice-intelligence product, with every
screen connected to the same local conversation record.

## Before recording

1. From the project root, run `npm run dev` and keep that terminal open.
2. Open `http://localhost:3000` in **Microsoft Edge or Google Chrome**.
   `localhost` is a secure context for microphone use; no public URL is needed
   for browser voice mode.
3. Sign in, open **Voice Agents**, and keep **Voice** selected (not Text Mode).
4. When the browser asks, allow microphone access for `http://localhost:3000`.
5. Enable **Require approval before replying** when the demo should show an
   operator reviewing a grounded response before it is spoken.

The browser microphone, browser speech recognition, and browser text-to-speech
run the live local voice experience. Each recognized utterance is sent to the
same Veyra session used by live insights, nudges, human handoff, analytics, and
after-call review.

## Suggested recording sequence

1. **Dashboard** — show the local service availability cards.
2. **Voice Agents** — select **Aria · India Loans** and start a voice call.
3. Say: **“What is the minimum age requirement for a loan?”**
   - Show the live transcript, grounded answer, and source citation.
4. With approval mode enabled, say: **“What documents are required for a
   personal loan?”**
   - Show the knowledge-tip nudge in **Live guidance**.
   - Review or edit it, then select **Use this reply**. The approved answer is
     added to the transcript and spoken by the browser.
5. Say: **“I need to speak to a supervisor right now.”**
   - Show the recorded human handoff and high-priority escalation nudge.
   - Open **Live Insights** or **Handoff Inbox** to show the same active call
     from an operator view.
6. End the call and open **Call History**.
   - Show the source-linked transcript, call timeline, nudge history, and
     evidence-linked after-call summary.

## Recording guidance

- Use a quiet room and wait briefly after each sentence; the browser submits a
  voice turn after a short silence.
- Let the agent finish speaking before asking the next question. Veyra pauses
  recognition while its response is spoken to avoid transcribing its own voice.
- Keep the development terminal out of the recording. Browser refreshes can
  produce harmless development WebSocket reset messages that do not affect the
  product workflow.
- Start a fresh session for the recording. Test calls in Call History remain as
  local audit records.

## Scope of the local demo

Browser voice is fully local to the product workflow. Vapi phone/web-call
provisioning is intentionally unavailable on localhost because Vapi requires a
public HTTPS callback to keep all answers grounded and authenticated. Do not
use the Vapi configuration endpoint as the local voice demo path.
