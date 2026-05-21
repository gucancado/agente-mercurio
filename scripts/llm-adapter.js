/**
 * llm-adapter.js — núcleo do adapter LLM.
 *
 * Exporta `complete(request)` que aceita o mesmo shape independente do
 * provedor e devolve o mesmo shape de resposta. Usado tanto pela CLI
 * (llm-call.js) quanto pelo orquestrador (process-tick-message.js).
 *
 * Request:
 *   {
 *     task: 'classify' | 'respond_low' | 'respond_medium' | 'respond_high' | string,
 *     model: 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'gemini-2.5-flash' | ...,
 *     system: [{ text, cache: bool }, ...]   // blocos do system prompt
 *     messages: [{ role, content }, ...]      // role: 'user' | 'assistant'
 *     responseSchema?: { ... }                // JSON schema → força structured output
 *     maxTokens?: number                       // default 2048
 *     temperature?: number                     // default 0.6
 *   }
 *
 * Response:
 *   {
 *     result: string | object,                // string normal; object se responseSchema
 *     model, provider,
 *     tokens_in, tokens_out,
 *     cache_read_tokens, cache_write_tokens,
 *     cost_usd,
 *     latency_ms,
 *     raw_finish_reason
 *   }
 */

const https = require('node:https');

// ── Pricing tables (USD per 1M tokens) ──────────────────────────────────

const PRICING = {
  // Anthropic — input / output / cache_read (10% input) / cache_write (125% input)
  'claude-haiku-4-5':       { in: 1.00, out: 5.00, cache_read: 0.10, cache_write: 1.25 },
  'claude-sonnet-4-6':      { in: 3.00, out: 15.0, cache_read: 0.30, cache_write: 3.75 },
  'claude-opus-4-7':        { in: 15.0, out: 75.0, cache_read: 1.50, cache_write: 18.75 },

  // Google Gemini
  'gemini-2.5-flash':       { in: 0.075, out: 0.30 },
  'gemini-2.5-flash-lite':  { in: 0.10,  out: 0.40 },
  'gemini-2.5-pro':         { in: 1.25,  out: 5.00 },
  'gemini-2.0-flash':       { in: 0.10,  out: 0.40 },
  'gemini-2.0-flash-lite':  { in: 0.075, out: 0.30 },
};

function getPricing(model) {
  return PRICING[model] || { in: 1.0, out: 5.0 };
}

// ── HTTPS helper ────────────────────────────────────────────────────────

function httpsRequest(url, opts, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOpts = {
      method: opts.method || 'POST',
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: opts.headers || {},
    };
    if (body) {
      reqOpts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch (e) { reject(new Error(`Parse error (${res.statusCode}): ${data.slice(0, 300)}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Anthropic adapter ───────────────────────────────────────────────────

async function callAnthropic(req) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY não definida');

  // System: array de blocks. Marca cache_control no último bloco que `cache: true`
  const systemBlocks = (req.system || []).map((b, i, arr) => {
    const block = { type: 'text', text: b.text };
    // Aplica cache_control no último bloco que pede cache.
    // Anthropic limita 4 breakpoints; estratégia: marcar todos os `cache: true`
    // mas se passar de 4, marca só os últimos 4. Pra v1 só usamos 1-2 breakpoints.
    if (b.cache) block.cache_control = { type: 'ephemeral' };
    return block;
  });

  const body = {
    model: req.model,
    max_tokens: req.maxTokens || 2048,
    temperature: req.temperature ?? 0.6,
    system: systemBlocks.length ? systemBlocks : undefined,
    messages: req.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : m.content,
    })),
  };

  // Structured output via tool_use: define uma tool que mirror o schema,
  // força a chamada dela. Padrão estável e mais antigo que json_schema mode.
  if (req.responseSchema) {
    body.tools = [{
      name: 'emit_structured_output',
      description: 'Devolve a saída no formato JSON especificado pelo schema.',
      input_schema: req.responseSchema,
    }];
    body.tool_choice = { type: 'tool', name: 'emit_structured_output' };
  }

  const t0 = Date.now();
  const { body: resp } = await httpsRequest(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    },
    JSON.stringify(body)
  );
  const latency_ms = Date.now() - t0;

  // Parse content. Se foi tool_use forçado, pega o input do tool_use block.
  // Senão, concatena text blocks.
  let result;
  if (req.responseSchema) {
    const tu = (resp.content || []).find((c) => c.type === 'tool_use');
    if (!tu) {
      throw new Error(`Anthropic não emitiu tool_use. Stop reason: ${resp.stop_reason}`);
    }
    result = tu.input;
  } else {
    result = (resp.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
  }

  const u = resp.usage || {};
  const tokens_in = u.input_tokens || 0;
  const tokens_out = u.output_tokens || 0;
  const cache_read_tokens = u.cache_read_input_tokens || 0;
  const cache_write_tokens = u.cache_creation_input_tokens || 0;

  const p = getPricing(req.model);
  // Custo: input pago (não cacheado) + cache_read no preço de cache_read
  // + cache_write no preço de cache_write + output normal
  const cost_usd = (
    tokens_in * p.in +
    cache_read_tokens * (p.cache_read || p.in * 0.1) +
    cache_write_tokens * (p.cache_write || p.in * 1.25) +
    tokens_out * p.out
  ) / 1e6;

  return {
    result,
    model: req.model,
    provider: 'anthropic',
    tokens_in,
    tokens_out,
    cache_read_tokens,
    cache_write_tokens,
    cost_usd,
    latency_ms,
    raw_finish_reason: resp.stop_reason,
  };
}

// ── Gemini adapter ──────────────────────────────────────────────────────

async function callGemini(req) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY não definida');

  // Gemini não tem "system" separado — junta tudo no primeiro user message,
  // OU usa systemInstruction. Vamos com systemInstruction.
  const systemText = (req.system || []).map((b) => b.text).join('\n\n');

  const body = {
    contents: req.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: typeof m.content === 'string'
        ? [{ text: m.content }]
        : m.content.map((c) => c.type === 'text' ? { text: c.text } : c),
    })),
    generationConfig: {
      temperature: req.temperature ?? 0.6,
      maxOutputTokens: req.maxTokens || 2048,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }

  if (req.responseSchema) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = req.responseSchema;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const t0 = Date.now();
  const { body: resp } = await httpsRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }, JSON.stringify(body));
  const latency_ms = Date.now() - t0;

  const candidate = resp.candidates?.[0];
  if (!candidate) {
    throw new Error(`Gemini sem candidates: ${JSON.stringify(resp).slice(0, 300)}`);
  }
  const text = candidate.content?.parts?.map((p) => p.text || '').join('') || '';

  let result;
  if (req.responseSchema) {
    try { result = JSON.parse(text); }
    catch (e) { throw new Error(`Gemini retornou JSON inválido: ${text.slice(0, 300)}`); }
  } else {
    result = text;
  }

  const u = resp.usageMetadata || {};
  const tokens_in = u.promptTokenCount || 0;
  const tokens_out = u.candidatesTokenCount || 0;

  const p = getPricing(req.model);
  const cost_usd = (tokens_in * p.in + tokens_out * p.out) / 1e6;

  return {
    result,
    model: req.model,
    provider: 'google',
    tokens_in,
    tokens_out,
    cache_read_tokens: 0,    // Gemini context caching usa API separada — n/a por enquanto
    cache_write_tokens: 0,
    cost_usd,
    latency_ms,
    raw_finish_reason: candidate.finishReason,
  };
}

// ── Public API ──────────────────────────────────────────────────────────

async function complete(req) {
  if (!req.model) throw new Error('complete: req.model obrigatório');
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new Error('complete: req.messages obrigatório (array não-vazio)');
  }

  const isGemini = /^gemini/i.test(req.model);
  return isGemini ? callGemini(req) : callAnthropic(req);
}

module.exports = { complete, getPricing, PRICING };
