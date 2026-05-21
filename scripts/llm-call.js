#!/usr/bin/env node
/**
 * llm-call.js — adapter universal pra invocar LLMs.
 *
 * Uso (compatível com `claude --print --model X --output-format json`):
 *   node llm-call.js --model <model> [--max-turns N] < prompt > stdout
 *
 * Modelos suportados:
 *   - claude-*  → shell-out pra `claude --print`
 *   - gemini-*  → HTTPS direto pra Generative Language API
 *
 * Saída (stdout JSON):
 *   { "result": "<texto da resposta>", "total_cost_usd": 0.0123, "num_turns": 1, "model": "..." }
 *
 * Stderr é usado pra mensagens de erro/diagnóstico.
 */

const { spawn } = require('node:child_process');
const https = require('node:https');

function parseArgs(argv) {
  const args = { model: 'claude-haiku-4-5', maxTurns: 3 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') args.model = argv[++i];
    else if (argv[i] === '--max-turns') args.maxTurns = parseInt(argv[++i], 10);
  }
  return args;
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

// ── Claude branch ────────────────────────────────────────────────────────

function callClaude(prompt, model, maxTurns) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '--print',
      '--model', model,
      '--max-turns', String(maxTurns),
      '--output-format', 'json',
      '--setting-sources', 'project',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`claude exit ${code}: ${stderr.slice(0, 500)}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        // Normaliza shape: já vem no formato esperado
        resolve({
          result: parsed.result || '',
          total_cost_usd: parsed.total_cost_usd || 0,
          num_turns: parsed.num_turns || 1,
          model,
        });
      } catch (err) {
        reject(new Error(`claude output não-JSON: ${stdout.slice(0, 300)}`));
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ── Gemini branch ────────────────────────────────────────────────────────

// Preços por milhão de tokens (USD) — atualizar conforme Google publica.
const GEMINI_PRICING = {
  'gemini-2.5-flash':       { in: 0.075, out: 0.30 },
  'gemini-2.5-flash-lite':  { in: 0.10,  out: 0.40 },
  'gemini-2.5-pro':         { in: 1.25,  out: 5.00 },
  'gemini-2.0-flash':       { in: 0.10,  out: 0.40 },
  'gemini-2.0-flash-lite':  { in: 0.075, out: 0.30 },
};

function httpsPostJSON(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      method: 'POST',
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`Gemini parse error: ${data.slice(0, 300)}`)); }
        } else {
          reject(new Error(`Gemini HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callGemini(prompt, model) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY não definido');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 2048,
    },
    safetySettings: [
      // Setting BLOCK_NONE pra evitar bloqueios de safety em conversas comerciais.
      // Conteúdo do SDR não toca temas sensíveis; bloqueio só atrapalha.
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  });

  const resp = await httpsPostJSON(url, body);

  const candidate = resp.candidates?.[0];
  if (!candidate) {
    throw new Error(`Gemini sem candidates: ${JSON.stringify(resp).slice(0, 300)}`);
  }
  const text = candidate.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) {
    throw new Error(`Gemini reply vazio. finishReason=${candidate.finishReason}`);
  }

  const usage = resp.usageMetadata || {};
  const inputTokens = usage.promptTokenCount || 0;
  const outputTokens = usage.candidatesTokenCount || 0;
  const pricing = GEMINI_PRICING[model] || { in: 0.10, out: 0.40 };
  const cost = (inputTokens * pricing.in + outputTokens * pricing.out) / 1e6;

  return {
    result: text,
    total_cost_usd: cost,
    num_turns: 1,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prompt = await readStdin();
  if (!prompt.trim()) {
    process.stderr.write('llm-call: prompt vazio na stdin\n');
    process.exit(2);
  }

  const isGemini = /^gemini/i.test(args.model);
  const result = isGemini
    ? await callGemini(prompt, args.model)
    : await callClaude(prompt, args.model, args.maxTurns);

  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stderr.write(`llm-call error: ${err.message}\n`);
  process.exit(1);
});
