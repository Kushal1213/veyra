import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'));
}

function readText(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function parseRequirements(text) {
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const match = line.match(/^([A-Za-z0-9_.-]+(?:\[[A-Za-z0-9_,.-]+\])?)(==|>=|<=|~=|>|<)?(.+)?$/);
      return {
        name: match?.[1] || line,
        specifier: match?.[2] ? `${match[2]}${match[3] || ''}` : '',
        pinned: match?.[2] === '==',
      };
    });
}

function packageDeps(path) {
  const pkg = readJson(path);
  return {
    name: pkg.name,
    dependencies: pkg.dependencies || {},
    devDependencies: pkg.devDependencies || {},
    engines: pkg.engines || {},
  };
}

function sourceDefault(text, pattern) {
  const match = text.match(pattern);
  return match?.[1] || null;
}

function sourceIncludes(path, value) {
  return readText(path).includes(value);
}

function maybeRunNpmAudit() {
  try {
    const npmExecPath = process.env.npm_execpath;
    const command = npmExecPath ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const args = npmExecPath ? [npmExecPath, 'audit', '--json'] : ['audit', '--json'];
    const raw = execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    return JSON.parse(raw);
  } catch (error) {
    const output = error.stdout?.toString();
    if (output) {
      try {
        return JSON.parse(output);
      } catch {
        return { error: 'npm audit returned non-JSON output' };
      }
    }
    return { error: error.message };
  }
}

function summarizeAudit(audit) {
  if (!audit || audit.error) return { available: false, error: audit?.error || 'not run' };
  const vulnerabilities = audit.metadata?.vulnerabilities || {};
  return {
    available: true,
    total: vulnerabilities.total || 0,
    critical: vulnerabilities.critical || 0,
    high: vulnerabilities.high || 0,
    moderate: vulnerabilities.moderate || 0,
    low: vulnerabilities.low || 0,
    info: vulnerabilities.info || 0,
  };
}

export function buildInventory(options = {}) {
  const frontend = packageDeps('apps/frontend/package.json');
  const gateway = packageDeps('apps/api-gateway/package.json');
  const rootPkg = packageDeps('package.json');
  const requirements = parseRequirements(readText('services/requirements.txt'));
  const ragSource = readText('services/rag-service/main.py');
  const ingestionSource = readText('services/ingestion-service/main.py');
  const vapiSource = readText('apps/api-gateway/src/routes/vapi-config.js');
  const envExample = readText('.env.example');
  const audit = options.includeAudit ? maybeRunNpmAudit() : null;

  const pythonByName = Object.fromEntries(requirements.map((item) => [item.name.toLowerCase(), item]));
  const googleGenAi = pythonByName['google-genai'];
  const legacyGoogleGenerativeAi = pythonByName['google-generativeai'];

  const findings = [];
  if (legacyGoogleGenerativeAi || !googleGenAi) {
    findings.push({
      id: 'google-generativeai-review-required',
      severity: 'high',
      area: 'provider-sdk',
      summary: 'The maintained google-genai dependency or adapter is missing; provider SDK remediation is required.',
      evidence: ['services/requirements.txt', 'services/rag-service/main.py', 'services/ingestion-service/main.py'],
    });
  }
  if (!envExample.includes('EMBEDDING_MODEL=models/gemini-embedding-001') || !envExample.includes('EMBEDDING_DIM=3072')) {
    findings.push({
      id: 'env-embedding-model-drift',
      severity: 'moderate',
      area: 'configuration',
      summary: '.env.example does not match the runtime Gemini embedding model and dimension.',
      evidence: ['.env.example', 'services/rag-service/main.py', 'services/ingestion-service/main.py'],
    });
  }
  if (sourceIncludes('apps/api-gateway/src/routes/vapi-config.js', 'gpt-4o-mini')) {
    findings.push({
      id: 'vapi-openai-fallback-review',
      severity: 'moderate',
      area: 'voice-provider',
      summary: 'Vapi fallback config contains an OpenAI model path; live account and data handling review are pending.',
      evidence: ['apps/api-gateway/src/routes/vapi-config.js'],
    });
  }

  return {
    generated_at: new Date().toISOString(),
    repository: 'veyra-voice-intelligence-suite',
    runtime: {
      node: rootPkg.engines?.node || gateway.engines?.node || null,
      python_requirements: 'services/requirements.txt',
    },
    providers: [
      {
        name: 'Gemini API',
        purpose: ['retrieval embeddings', 'optional answer generation'],
        sdk: googleGenAi ? { package: googleGenAi.name, specifier: googleGenAi.specifier, pinned: googleGenAi.pinned } : null,
        environment: ['GEMINI_API_KEY', 'GEMINI_MODEL'],
        configured_defaults: {
          rag_model: sourceDefault(ragSource, /GEMINI_MODEL\s*=\s*os\.getenv\("GEMINI_MODEL",\s*"([^"]+)"/),
          rag_embedding_model: sourceDefault(ragSource, /EMBEDDING_MODEL\s*=\s*"([^"]+)"/),
          ingestion_embedding_model: sourceDefault(ingestionSource, /EMBEDDING_MODEL\s*=\s*"([^"]+)"/),
          embedding_dimension: Number(sourceDefault(ragSource, /EMBEDDING_DIM\s*=\s*(\d+)/)),
        },
        live_smoke_test: 'not_run',
      },
      {
        name: 'Vapi',
        purpose: ['browser voice SDK', 'voice provider orchestration'],
        sdk: frontend.dependencies['@vapi-ai/web'] ? { package: '@vapi-ai/web', specifier: frontend.dependencies['@vapi-ai/web'] } : null,
        environment: [
          'VAPI_API_KEY',
          'VAPI_PHONE_NUMBER_ID',
          'VITE_VAPI_PUBLIC_KEY',
          'PUBLIC_WEBHOOK_URL',
          'VOICE_SERVICE_TOKEN',
          'VAPI_SERVER_CREDENTIAL_ID',
          'VAPI_CUSTOM_LLM_CREDENTIAL_ID',
        ],
        configured_defaults: {
          custom_llm_model: sourceIncludes('apps/api-gateway/src/routes/vapi-config.js', 'veyra-rag') ? 'veyra-rag' : null,
          fallback_llm_model: sourceIncludes('apps/api-gateway/src/routes/vapi-config.js', 'gpt-4o-mini') ? 'gpt-4o-mini' : null,
        },
        live_smoke_test: 'not_run',
      },
      {
        name: 'Deepgram via Vapi',
        purpose: ['speech-to-text', 'text-to-speech voice'],
        sdk: null,
        environment: ['DEEPGRAM_API_KEY'],
        configured_defaults: {
          transcriber_model: sourceIncludes('apps/api-gateway/src/routes/vapi-config.js', 'nova-2') ? 'nova-2' : null,
          provider: sourceIncludes('apps/api-gateway/src/routes/vapi-config.js', 'deepgram') ? 'deepgram' : null,
        },
        live_smoke_test: 'not_run',
      },
    ],
    dependencies: {
      npm_workspaces: [rootPkg, frontend, gateway].map((pkg) => ({
        name: pkg.name,
        dependencies: Object.keys(pkg.dependencies).length,
        devDependencies: Object.keys(pkg.devDependencies).length,
      })),
      python: {
        total: requirements.length,
        pinned: requirements.filter((item) => item.pinned).length,
        unpinned: requirements.filter((item) => !item.pinned).map((item) => item.name),
      },
      npm_audit: summarizeAudit(audit),
    },
    findings,
    notes: [
      'No secret values are read or emitted; only variable names and source defaults are reported.',
      'Live provider smoke tests are intentionally marked not_run until an authorized account and budget are available.',
      'This inventory does not replace a security review or provider data-processing review.',
    ],
  };
}

function parseArgs(argv) {
  const args = { output: null, includeAudit: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--audit') args.includeAudit = true;
    else if (value === '--output') {
      args.output = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const inventory = buildInventory({ includeAudit: args.includeAudit });
  const text = `${JSON.stringify(inventory, null, 2)}\n`;
  if (args.output) {
    const output = resolve(root, args.output);
    writeFileSync(output, text, 'utf8');
  }
  process.stdout.write(text);
}
