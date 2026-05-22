#!/usr/bin/env node
/**
 * run-offline-eval.js — roda checks de qualidade sobre as mensagens
 * outbound já salvas no DB (não chama LLM, custo zero).
 *
 * Uso:
 *   node tests/eval/run-offline-eval.js [--limit N] [--since 7d]
 *   node tests/eval/run-offline-eval.js --save-baseline
 *
 * Env vars necessárias:
 *   WORKER_URL    (default https://worker.beeads.com.br)
 *   WORKER_TOKEN  (auth com o worker do mercurio)
 *
 * Output: relatório legível no stdout + JSON em
 *   tests/eval/results/offline-<timestamp>.json
 * Se --save-baseline: também salva como tests/eval/baseline.json.
 */

const fs = require('node:fs');
const path = require('node:path');
const { checkMessage, aggregate } = require('./check-quality');

const ROOT = path.resolve(__dirname);
const RESULTS_DIR = path.join(ROOT, 'results');
const BASELINE_PATH = path.join(ROOT, 'baseline.json');

const WORKER_URL = process.env.WORKER_URL || 'https://worker.beeads.com.br';
const WORKER_TOKEN = process.env.WORKER_TOKEN;

if (!WORKER_TOKEN) {
  console.error('WORKER_TOKEN não setado. Export antes de rodar.');
  process.exit(2);
}

// ── CLI args ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { limit: 500, since: null, saveBaseline: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (argv[i] === '--since') args.since = argv[++i];
    else if (argv[i] === '--save-baseline') args.saveBaseline = true;
  }
  return args;
}

// ── Fetch outbound messages from worker ─────────────────────────────────

async function fetchOutboundMessages(limit) {
  const url = `${WORKER_URL}/messages?direction=outbound&limit=${limit}`;
  const r = await fetch(url, {
    headers: { 'X-Agent-Token': WORKER_TOKEN },
  });
  if (!r.ok) throw new Error(`GET /messages HTTP ${r.status}`);
  const json = await r.json();
  return json.messages || [];
}

/**
 * Pra detectar "primeira mensagem da thread" precisamos saber se já houve
 * outbound anterior pro mesmo (channel, identifier). Agrupa por thread.
 */
function annotateFirstOutboundFlag(messages) {
  // messages vem DESC por created_at; vamos ordenar ASC primeiro
  const sorted = [...messages].sort((a, b) =>
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  const seenThreads = new Set();
  for (const m of sorted) {
    const threadKey = `${m.channel}|${m.identifier}`;
    m._isFirstOutbound = !seenThreads.has(threadKey);
    seenThreads.add(threadKey);
  }
  return sorted;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(`[eval] fetching outbound messages (limit=${args.limit}) from ${WORKER_URL}...`);
  const messages = await fetchOutboundMessages(args.limit);
  console.log(`[eval] ${messages.length} mensagens outbound encontradas.`);

  if (messages.length === 0) {
    console.log('[eval] nada pra avaliar.');
    process.exit(0);
  }

  const annotated = annotateFirstOutboundFlag(messages);

  // Skip mensagens de smoke/teste (identifier sintético)
  const filtered = annotated.filter((m) => m.identifier !== '+5511999999999');
  console.log(`[eval] após filtrar smoke: ${filtered.length} mensagens.`);

  const results = filtered.map((m) =>
    checkMessage(m, { isFirstOutbound: m._isFirstOutbound })
  );

  const agg = aggregate(results);

  const report = {
    generated_at: new Date().toISOString(),
    sample_size: results.length,
    summary: agg,
    issues: results.filter(
      (r) =>
        r.checks.anti_padroes_count > 0 ||
        r.checks.saudacao_repetida ||
        r.checks.disclosure_repetido ||
        r.checks.muito_longo
    ),
  };

  // Print relatório
  console.log('\n══════════════════════════════════════════');
  console.log('  EVAL OFFLINE — Mercurio SDR');
  console.log('══════════════════════════════════════════\n');
  console.log(`Amostra: ${agg.total} mensagens outbound`);
  console.log('\n— Qualidade —');
  for (const [k, v] of Object.entries(agg.quality)) {
    console.log(`  ${k.padEnd(28)} ${v}`);
  }
  console.log('\n— Custo —');
  console.log(`  total_usd                    $${agg.cost.total_usd}`);
  console.log(`  avg_usd_per_response         $${agg.cost.avg_usd}`);
  console.log('\n— Latência —');
  console.log(`  avg_ms                       ${agg.latency_ms.avg}`);
  console.log(`  p95_ms                       ${agg.latency_ms.p95}`);
  console.log('\n— Distribuição por tier —');
  for (const [t, c] of Object.entries(agg.distribution_tier)) {
    const pct = ((c / agg.total) * 100).toFixed(1);
    console.log(`  ${t.padEnd(28)} ${c} (${pct}%)`);
  }
  console.log('\n— Distribuição por intent —');
  for (const [i, c] of Object.entries(agg.distribution_intent)) {
    const pct = ((c / agg.total) * 100).toFixed(1);
    console.log(`  ${i.padEnd(28)} ${c} (${pct}%)`);
  }
  console.log(`\n— Issues encontrados: ${report.issues.length} —`);
  for (const issue of report.issues.slice(0, 10)) {
    const flags = [];
    if (issue.checks.anti_padroes_count > 0)
      flags.push(`tom(${issue.checks.anti_padroes_hits.map((h) => h.word).join(',')})`);
    if (issue.checks.saudacao_repetida) flags.push('saudacao');
    if (issue.checks.disclosure_repetido) flags.push('disclosure');
    if (issue.checks.muito_longo) flags.push(`longo(${issue.checks.lines}L)`);
    console.log(`  id=${issue.message_id} [${flags.join('|')}]`);
    console.log(`    "${issue.text_preview}..."`);
  }
  if (report.issues.length > 10) {
    console.log(`  ... e mais ${report.issues.length - 10} (ver JSON completo)`);
  }
  console.log('\n══════════════════════════════════════════\n');

  // Persiste JSON
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const tsLabel = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(RESULTS_DIR, `offline-${tsLabel}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`[eval] resultado em ${outFile}`);

  if (args.saveBaseline) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(report, null, 2));
    console.log(`[eval] baseline salvo em ${BASELINE_PATH}`);
  } else if (fs.existsSync(BASELINE_PATH)) {
    // Compara contra baseline existente — só mostra deltas dos KPIs principais
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    console.log('— Δ vs baseline —');
    const cmp = (atual, base, kpi) => {
      const a = parseFloat(atual);
      const b = parseFloat(base);
      const delta = (a - b).toFixed(2);
      const sign = a > b ? '↑' : a < b ? '↓' : '=';
      console.log(`  ${kpi.padEnd(28)} ${atual} (baseline ${base}, ${sign}${delta})`);
    };
    cmp(agg.quality.anti_padroes_pct, baseline.summary.quality.anti_padroes_pct, 'anti_padroes_pct');
    cmp(agg.quality.saudacao_repetida_pct, baseline.summary.quality.saudacao_repetida_pct, 'saudacao_repetida_pct');
    cmp(agg.cost.avg_usd, baseline.summary.cost.avg_usd, 'cost.avg_usd');
    console.log('');
  } else {
    console.log('[eval] sem baseline ainda. Rode com --save-baseline pra criar.\n');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
