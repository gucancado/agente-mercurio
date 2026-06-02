/**
 * render.mjs — formata dados do worker em markdown legível para análise.
 *
 * Convenção de labels:
 *   - inbound  → "LEAD"
 *   - outbound → "AGENTE"   (NUNCA nome de persona. A persona pública é
 *                            "equipe BeeAds", definida em PROJECT.md, e não
 *                            tem nome próprio — o tool não propaga nome algum.)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Mapa de contatos de teste { numero: motivo }. */
export function loadTestContacts() {
  try {
    const raw = readFileSync(resolve(__dirname, 'test-contacts.json'), 'utf-8');
    return JSON.parse(raw).contacts || {};
  } catch {
    return {};
  }
}

function ts(iso) {
  return String(iso).slice(0, 19).replace('T', ' ');
}

function line(m) {
  const who = m.direction === 'inbound' ? 'LEAD  ' : 'AGENTE';
  const meta =
    m.direction === 'outbound'
      ? `  [${m.tier || '-'}/${m.classifier_intent || '-'}]`
      : '';
  const txt = String(m.text || '').replace(/\n/g, ' / ');
  return `${ts(m.created_at)} ${who}${meta}: ${txt}`;
}

/** Agrupa mensagens (já cronológicas) por identifier. */
function groupByThread(messages) {
  const th = new Map();
  for (const m of messages) {
    if (!th.has(m.identifier)) th.set(m.identifier, []);
    th.get(m.identifier).push(m);
  }
  return th;
}

/**
 * Renderiza todas as threads. Exclui contatos de teste salvo includeTests.
 * Retorna { text, stats }.
 */
export function renderThreads(messages, { includeTests = false } = {}) {
  const tests = loadTestContacts();
  const th = groupByThread(messages);
  const out = [];
  let shown = 0;
  let hidden = 0;

  const ordered = [...th.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [ident, msgs] of ordered) {
    const isTest = ident in tests;
    if (isTest && !includeTests) {
      hidden++;
      continue;
    }
    shown++;
    const tag = isTest ? `  ⚠️ TESTE (${tests[ident]})` : '';
    out.push(`\n${'='.repeat(78)}\nTHREAD ${ident}  (${msgs.length} msgs)  proj=${msgs[0].project ?? '-'}${tag}\n${'='.repeat(78)}`);
    for (const m of msgs) out.push(line(m));
  }

  const header =
    `# Conversas — ${shown} thread(s)` +
    (hidden ? `, ${hidden} de teste ocultas (use --include-tests)` : '') +
    `\n# ${messages.length} mensagens no recorte`;
  return { text: `${header}\n${out.join('\n')}`, stats: { shown, hidden, total: messages.length } };
}

/** Renderiza uma thread única (sempre mostra, mesmo se for teste). */
export function renderThread(messages, identifier) {
  if (!messages.length) return `Nenhuma mensagem para ${identifier}.`;
  const out = [`# Thread ${identifier}  (${messages.length} msgs)\n`];
  for (const m of messages) out.push(line(m));
  return out.join('\n');
}

export function renderMeetings(meetings) {
  const legacyBanner =
    '⚠️  LEGADO: este comando lê APENAS a tabela `simulated_meetings` (path sem project).\n' +
    '    Agendamentos reais (com project, ex. metido-a-gente) vão pro Google Calendar e\n' +
    '    NÃO aparecem aqui. NÃO use ausência de row aqui como prova de "confirmação fantasma" —\n' +
    '    cruze com o Google Calendar (MCP `claude.ai Google Calendar`) pra confirmar de verdade.\n';
  if (!meetings.length) return `${legacyBanner}\nNenhuma reunião na tabela legada simulated_meetings.`;
  const out = [legacyBanner, `# Reuniões legadas (simulated_meetings) — ${meetings.length}\n`];
  for (const m of meetings) {
    out.push(
      `[${m.status}] ${ts(m.slot_iso)}  "${m.slot_human || ''}"  ${m.lead_email || '-'}  ` +
        `empresa=${m.company || '-'}  criada=${ts(m.created_at)}` +
        (m.rescheduled_to ? `  → remarcada=${m.rescheduled_to}` : '')
    );
  }
  return out.join('\n');
}

export function renderMetrics(summary) {
  const rows = summary.rows || [];
  if (!rows.length) return `Sem métricas no período (${summary.since}).`;
  const out = [`# Métricas LLM — desde ${summary.since}\n`, 'hora | task | modelo | calls | custo | lat_avg | fallbacks | erros'];
  for (const r of rows) {
    out.push(
      `${ts(r.hour)} | ${r.task} | ${r.model} | ${r.calls} | $${r.cost_total ?? 0} | ${r.latency_avg ?? '-'}ms | ${r.fallbacks} | ${r.errors}`
    );
  }
  return out.join('\n');
}
