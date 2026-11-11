import express from 'express';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import axios from 'axios';
import { logger } from '../index.js';

const router = express.Router();
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * GET /api/vapi/assistant-config
 * Returns a Vapi assistant configuration that always sends conversational turns
 * through Veyra's authenticated, grounded custom-LLM endpoint. A public HTTPS
 * callback is required; falling back to a provider-hosted model would bypass the
 * product's RAG, escalation, and audit controls.
 */
router.get('/assistant-config', async (req, res) => {
  try {
    const market = req.query.market || 'india-loan';

    const agentMap = {
      'india-loan':       { name: 'Aria',  lang: 'en-IN', voice: 'aura-asteria-en' },
      'india-insurance':  { name: 'Priya', lang: 'en-IN', voice: 'aura-luna-en' },
      'ph-bancassurance': { name: 'Maria', lang: 'en-US', voice: 'aura-luna-en' },
      'id-finance':       { name: 'Dewi',  lang: 'id',    voice: 'aura-luna-en' },
    };
    const agent = agentMap[market] || agentMap['india-loan'];

    // Load system prompt
    let systemPrompt = `You are ${agent.name}, a professional Veyra AI voice agent helping customers with home loans and personal loans in India. Be concise — max 2 sentences per response. No bullet points or markdown.`;
    try {
      const promptsPath = join(__dirname, '../../../../services/rag-service/config/prompts.yaml');
      const yaml = readFileSync(promptsPath, 'utf-8');
      const parsed = parseYaml(yaml);
      if (parsed?.system_prompt) {
        systemPrompt = parsed.system_prompt + '\nBe concise. Max 2 sentences. No markdown or bullet points in voice.';
      }
    } catch (_e) { /* use default */ }

    const privateKey = process.env.VAPI_API_KEY;
    const publicUrl = (process.env.PUBLIC_WEBHOOK_URL || '').replace(/\/+$/, '');
    const hasPublicUrl = publicUrl && !publicUrl.includes('localhost') && publicUrl.startsWith('https://');
    if (!hasPublicUrl) {
      return res.status(503).json({
        code: 'VAPI_WEBHOOK_UNAVAILABLE',
        error: 'Vapi voice requires a publicly reachable HTTPS PUBLIC_WEBHOOK_URL so all answers remain grounded by Veyra.',
      });
    }

    // Vapi runs outside the browser and has no Veyra session cookie. Refuse to
    // provision an assistant unless both callback surfaces are protected with
    // the same server-only bearer token. This avoids saving an assistant that
    // will immediately receive 401 responses from the gateway.
    if ((process.env.VOICE_SERVICE_TOKEN || '').length < 32) {
      return res.status(503).json({
        code: 'VAPI_CALLBACK_AUTH_UNAVAILABLE',
        error: 'Set a random VOICE_SERVICE_TOKEN of at least 32 characters before configuring Vapi callbacks.',
      });
    }

    // Vapi stores credentials separately from an assistant. A server
    // credential authenticates lifecycle webhooks; a custom-LLM credential
    // authenticates the OpenAI-compatible streaming endpoint. They can use
    // the same VOICE_SERVICE_TOKEN but have distinct Vapi credential IDs.
    const webhookCredentialId = (process.env.VAPI_SERVER_CREDENTIAL_ID || '').trim();
    const customLlmCredentialId = (process.env.VAPI_CUSTOM_LLM_CREDENTIAL_ID || '').trim();
    if (!webhookCredentialId || !customLlmCredentialId) {
      return res.status(503).json({
        code: 'VAPI_CREDENTIAL_UNAVAILABLE',
        error: 'Create Vapi server and custom-LLM credentials, then set VAPI_SERVER_CREDENTIAL_ID and VAPI_CUSTOM_LLM_CREDENTIAL_ID.',
      });
    }
    const credentialIds = [...new Set([webhookCredentialId, customLlmCredentialId])];

    const model = {
      provider: 'custom-llm',
      // Preserve the selected regional agent when Vapi invokes the custom LLM
      // endpoint; otherwise every call would fall back to India.
      url: `${publicUrl}/api/voice/vapi-llm?market=${encodeURIComponent(market)}`,
      model: 'veyra-rag',
      messages: [{ role: 'system', content: systemPrompt }],
      temperature: 0.2,
      maxTokens: 200,
    };

    // ── Option A: Use Vapi REST API to create or update a grounded assistant ──
    if (privateKey && privateKey !== 'your_vapi_api_key') {
      try {
        const assistantPayload = {
          name: `Veyra-${process.env.VEYRA_TENANT_ID ? process.env.VEYRA_TENANT_ID + '-' : ''}${agent.name}-${market}`,
          firstMessage: `Hello! I'm ${agent.name}, your Veyra financial assistant. How can I help you today?`,
          transcriber: {
            provider: 'deepgram',
            model: 'nova-2',
            language: agent.lang,
            smartFormat: true,
          },
          model,
          voice: {
            provider: 'deepgram',
            voiceId: agent.voice,
          },
          credentialIds,
          server: {
            url: `${publicUrl}/api/voice/webhook`,
            timeoutSeconds: 20,
            credentialId: webhookCredentialId,
          },
          silenceTimeoutSeconds: 30,
          maxDurationSeconds: 600,
          endCallMessage: `Thank you for speaking with ${agent.name}. Have a great day!`,
        };

        // Upsert: check if assistant already exists for this market
        const listResp = await axios.get('https://api.vapi.ai/assistant', {
          headers: { Authorization: `Bearer ${privateKey}` },
          params: { limit: 100 },
          timeout: 8000,
        });

        const existing = listResp.data?.find?.(a => a.name === assistantPayload.name);

        let assistantId;
        if (existing) {
          // Update existing assistant
          const updateResp = await axios.patch(
            `https://api.vapi.ai/assistant/${existing.id}`,
            assistantPayload,
            { headers: { Authorization: `Bearer ${privateKey}` }, timeout: 8000 }
          );
          assistantId = updateResp.data.id;
          logger.info({ assistantId, market }, 'Vapi assistant updated');
        } else {
          // Create new assistant
          const createResp = await axios.post(
            'https://api.vapi.ai/assistant',
            assistantPayload,
            { headers: { Authorization: `Bearer ${privateKey}` }, timeout: 8000 }
          );
          assistantId = createResp.data.id;
          logger.info({ assistantId, market }, 'Vapi assistant created');
        }

        return res.json({ assistantId, mode: 'rag-grounded' });
      } catch (vapiErr) {
        logger.error({ err: vapiErr?.response?.data || vapiErr.message }, 'Vapi API call failed, returning grounded inline config');
        // Fall through to inline config
      }
    }

    // ── Option B: Grounded inline config (no private Vapi API key or API failure) ──
    logger.warn('Returning grounded inline Vapi assistant config');
    const inlineConfig = {
      name: `${agent.name} - Veyra Voice Agent`,
      firstMessage: `Hello! I'm ${agent.name}, your Veyra financial assistant. How can I help?`,
      transcriber: { provider: 'deepgram', model: 'nova-2', language: agent.lang },
      model,
      voice: { provider: 'deepgram', voiceId: agent.voice },
      credentialIds,
      server: {
        url: `${publicUrl}/api/voice/webhook`,
        timeoutSeconds: 20,
        credentialId: webhookCredentialId,
      },
      silenceTimeoutSeconds: 30,
      maxDurationSeconds: 600,
    };
    res.json({ ...inlineConfig, mode: 'rag-grounded' });

  } catch (err) {
    logger.error(err, 'Failed to build Vapi assistant config');
    res.status(500).json({ error: 'Config generation failed', message: err.message });
  }
});

export default router;
