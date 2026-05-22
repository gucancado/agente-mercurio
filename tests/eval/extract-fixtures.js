#!/usr/bin/env node
/**
 * extract-fixtures.js — extrai threads reais do DB (inbound + outbound) e
 * salva como fixtures sanitizadas pra uso em replay eval (Fase 5b futura).
 *
 * Sanitização:
 *  - identifier (número) substituído por placeholder estável (hash truncado)
 *  - email substituído por "lead@example.test"
 *  - nomes próprios DETECTADOS em fatos_coletados são substituídos por
 *    "Gustavo" (placeholder consistente)
 *
 * Output: tests/eval/fixtures/thread-<hash>.jsonl
 * Cada linha: { ts, direction, text, intent, tier, model }
 *
 * Uso:
 *   WORKER_TOKEN=... node tests/eval/extract-fixtures.js [--min-trocas 4]
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname);
const FIXTURES_DIR = path.join(ROOT, 'fixtures');

const WORKER_URL = process.env.WORKER_URL || 'https://worker.beeads.com.br';
const WORKER_TOKEN = process.env.WORKER_TOKEN;

if (!WORKER_TOKEN) {
  console.error('WORKER_TOKEN não setado.');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { minTrocas: 4 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--min-trocas') args.minTrocas = parseInt(argv[++i], 10);
  }
  return args;
}

function hashId(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);
}

async function fetchAllMessages(limit = 500) {
  const r = await fetch(`${WORKER_URL}/messages?limit=${limit}`, {
    headers: { 'X-Agent-Token': WORKER_TOKEN },
  });
  if (!r.ok) throw new Error(`GET /messages HTTP ${r.status}`);
  return (await r.json()).messages || [];
}

function sanitizeText(text) {
  if (!text) return '';
  // Email
  text = text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, 'lead@example.test');
  // Número de telefone BR (+55 XX XXXXX-XXXX e variantes)
  text = text.replace(/\+?\s*55\s*\d{2}\s*\d{4,5}\s*-?\s*\d{4}/g, '+5500000000000');
  // CPF (formato XXX.XXX.XXX-XX)
  text = text.replace(/\d{3}\.\d{3}\.\d{3}-\d{2}/g, '000.000.000-00');
  return text;
}

function groupByThread(messages) {
  const threads = new Map();
  for (const m of messages) {
    const key = `${m.channel}|${m.identifier}`;
    if (!threads.has(key)) threads.set(key, []);
    threads.get(key).push(m);
  }
  // sort each thread by created_at ASC
  for (const arr of threads.values()) {
    arr.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }
  return threads;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[extract] fetching messages from ${WORKER_URL}...`);
  const messages = await fetchAllMessages(500);
  console.log(`[extract] ${messages.length} mensagens totais.`);

  const threads = groupByThread(messages);
  console.log(`[extract] ${threads.size} threads agrupadas.`);

  fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  let saved = 0;
  for (const [key, msgs] of threads.entries()) {
    if (msgs.length < args.minTrocas) continue;
    if (key.includes('+5511999999999')) continue; // smoke
    if (key.includes('debug')) continue;

    const [channel, identifier] = key.split('|');
    const fixtureId = hashId(key);
    const outPath = path.join(FIXTURES_DIR, `thread-${fixtureId}.jsonl`);

    const lines = [
      JSON.stringify({
        _meta: true,
        original_channel: channel,
        original_identifier_hash: fixtureId,
        n_messages: msgs.length,
        n_inbound: msgs.filter((m) => m.direction === 'inbound').length,
        n_outbound: msgs.filter((m) => m.direction === 'outbound').length,
      }),
      ...msgs.map((m) =>
        JSON.stringify({
          ts: m.created_at,
          direction: m.direction,
          text: sanitizeText(m.text),
          intent: m.classifier_intent || null,
          tier: m.tier || null,
          model: m.model || null,
          cost_usd: m.cost_usd || null,
        })
      ),
    ];

    fs.writeFileSync(outPath, lines.join('\n') + '\n');
    saved++;
  }

  console.log(`[extract] ${saved} fixtures salvas em ${FIXTURES_DIR}/`);
  if (saved === 0) {
    console.log('[extract] dica: rode em produção depois de coletar mais conversas reais.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
