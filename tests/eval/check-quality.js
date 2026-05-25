/**
 * check-quality.js — bateria de checks automáticos sobre mensagens
 * outbound do agente.
 *
 * Usado tanto pelo eval offline (sobre messages do DB) quanto pelo eval
 * de replay futuro (sobre outputs gerados).
 *
 * Cada check retorna { name, pass, details } e o aggregate computa score.
 */

// ── Anti-padrões de tom (palavras proibidas pela skill anti-padroes-tom) ──
const ANTI_PADROES_TOM = [
  { word: 'a gente', alt: 'nós/somos/estamos' },
  { word: 'tô ', alt: 'estou' },
  // 'tá' isolado é difícil de regex sem falso positivo (parte de "está"), pulo
  { word: ' pra ', alt: 'para' },
  { word: ' beleza', alt: 'certo/perfeito' },
  { word: ' rola ', alt: 'é interessante' },
  { word: ' show', alt: 'ótimo' },
  { word: ' tranquilo', alt: 'sem problema' },
  { word: ' viu?', alt: '(omitir)' },
  { word: 'prezado', alt: '(não usar)' },
  { word: 'vossa senhoria', alt: '(não usar)' },
  { word: 'atenciosamente', alt: '(não usar)' },
];

// ── Regex de saudação ────────────────────────────────────────────────────
// Mensagem começa com "Oi" / "Olá" / "Bom dia" / "Boa tarde" / "Boa noite"
// seguido (ou não) de nome próprio
const SAUDACAO_REGEX = /^\s*(Oi|Olá|Bom dia|Boa tarde|Boa noite)\b/i;

// ── Disclosure regex ─────────────────────────────────────────────────────
const DISCLOSURE_REGEX = /agente automatizad[ao].*operad[ao] por humanos|sou (?:um |uma )?(?:agente|robô|bot|IA)/i;

// ── Identidade proibida (nomes internos/legados não devem vazar no chat) ──
// "Mel" foi o nome interno legado até 2026-05-25 (renomeado pra "SDR da BeeAds").
// Esse check garante que o nome antigo não reapareça em outbounds.
// Captura "Mel" como palavra isolada — evita falsos positivos com "Melhor", "Melissa", etc.
const NOME_MEL_REGEX = /\bMel\b/;

// ── Em-dash proibido ─────────────────────────────────────────────────────
const EM_DASH_REGEX = /—/;
// Hífen com espaços com função de em-dash (" - " entre cláusulas)
const HIFEN_FAKE_DASH_REGEX = / - /;

/**
 * Detecta anti-padrões de tom numa mensagem.
 * @param {string} text
 * @returns {{ hits: Array<{word, alt}>, count: number }}
 */
function checkAntiPadroes(text) {
  const lower = ' ' + text.toLowerCase() + ' ';
  const hits = [];
  for (const { word, alt } of ANTI_PADROES_TOM) {
    if (lower.includes(word.toLowerCase())) {
      hits.push({ word: word.trim(), alt });
    }
  }
  return { hits, count: hits.length };
}

/**
 * Detecta se a mensagem começa com saudação (problema quando é-primeira-msg=false).
 */
function startsWithSaudacao(text) {
  return SAUDACAO_REGEX.test(text);
}

/**
 * Detecta se há disclosure ("agente automatizada da BeeAds, operada por humanos").
 */
function hasDisclosure(text) {
  return DISCLOSURE_REGEX.test(text);
}

/**
 * Quebra mensagem em linhas não-vazias.
 */
function countLines(text) {
  return text.split('\n').filter((l) => l.trim().length > 0).length;
}

/**
 * Roda todos os checks sobre uma única mensagem outbound + contexto
 * (precedida ou não por outras outbound do mesmo lead).
 *
 * @param {object} msg — row da tabela messages (direction=outbound)
 * @param {object} ctx — { isFirstOutbound: bool, threadMessagesBefore: number }
 * @returns {object} resultado dos checks
 */
function checkMessage(msg, ctx) {
  const text = msg.text || '';
  const antiPadroes = checkAntiPadroes(text);
  const startsSaudacao = startsWithSaudacao(text);
  const hasDisc = hasDisclosure(text);
  const lines = countLines(text);
  const hasMel = NOME_MEL_REGEX.test(text);
  const hasEmDash = EM_DASH_REGEX.test(text);
  const hasFakeDash = HIFEN_FAKE_DASH_REGEX.test(text);

  // Quando NÃO é a primeira outbound da thread, começar com saudação é problema.
  const saudacaoRepetida = !ctx.isFirstOutbound && startsSaudacao;

  // Disclosure NÃO deve aparecer proativo (nem na primeira). Só se o lead
  // perguntar, mas detecção do contexto "houve pergunta?" é complexa offline.
  // Tratamento atual: qualquer disclosure aparece como warning (provavelmente
  // tem casos legítimos, mas é raro).
  const disclosureProativo = hasDisc;

  // Comprimento alvo: <= 4 linhas; warn se > 5.
  const muitoLongo = lines > 5;

  return {
    message_id: msg.id,
    direction: msg.direction,
    tier: msg.tier,
    classifier_intent: msg.classifier_intent,
    cost_usd: msg.cost_usd,
    latency_ms: msg.latency_ms,
    is_first_outbound: ctx.isFirstOutbound,
    text_preview: text.slice(0, 80),
    checks: {
      anti_padroes_count: antiPadroes.count,
      anti_padroes_hits: antiPadroes.hits,
      saudacao_repetida: saudacaoRepetida,
      disclosure_proativo: disclosureProativo,
      nome_mel_no_texto: hasMel,
      em_dash_no_texto: hasEmDash,
      hifen_fake_dash: hasFakeDash,
      muito_longo: muitoLongo,
      lines,
    },
  };
}

/**
 * Agrega resultados de múltiplas mensagens em um relatório.
 */
function aggregate(results) {
  const total = results.length;
  if (total === 0) {
    return { total: 0, message: 'sem mensagens outbound pra avaliar' };
  }

  const antiPadroesHits = results.reduce((acc, r) => acc + r.checks.anti_padroes_count, 0);
  const saudacaoRepetidaCount = results.filter((r) => r.checks.saudacao_repetida).length;
  const disclosureProativoCount = results.filter((r) => r.checks.disclosure_proativo).length;
  const nomeMelCount = results.filter((r) => r.checks.nome_mel_no_texto).length;
  const emDashCount = results.filter((r) => r.checks.em_dash_no_texto).length;
  const fakeDashCount = results.filter((r) => r.checks.hifen_fake_dash).length;
  const muitoLongoCount = results.filter((r) => r.checks.muito_longo).length;

  const custoTotal = results.reduce((acc, r) => acc + (parseFloat(r.cost_usd) || 0), 0);
  const latencias = results
    .map((r) => r.latency_ms)
    .filter((l) => l !== null && l !== undefined)
    .sort((a, b) => a - b);
  const latencyAvg = latencias.length
    ? latencias.reduce((a, b) => a + b, 0) / latencias.length
    : null;
  const latencyP95 = latencias.length
    ? latencias[Math.floor(latencias.length * 0.95)] || latencias[latencias.length - 1]
    : null;

  const porTier = {};
  for (const r of results) {
    const t = r.tier || 'unknown';
    porTier[t] = (porTier[t] || 0) + 1;
  }

  const porIntent = {};
  for (const r of results) {
    const i = r.classifier_intent || 'unknown';
    porIntent[i] = (porIntent[i] || 0) + 1;
  }

  return {
    total,
    quality: {
      anti_padroes_total: antiPadroesHits,
      anti_padroes_pct: ((antiPadroesHits / total) * 100).toFixed(1) + '%',
      saudacao_repetida_count: saudacaoRepetidaCount,
      saudacao_repetida_pct: ((saudacaoRepetidaCount / total) * 100).toFixed(1) + '%',
      disclosure_proativo_count: disclosureProativoCount,
      disclosure_proativo_pct: ((disclosureProativoCount / total) * 100).toFixed(1) + '%',
      nome_mel_count: nomeMelCount,
      nome_mel_pct: ((nomeMelCount / total) * 100).toFixed(1) + '%',
      em_dash_count: emDashCount,
      em_dash_pct: ((emDashCount / total) * 100).toFixed(1) + '%',
      hifen_fake_dash_count: fakeDashCount,
      hifen_fake_dash_pct: ((fakeDashCount / total) * 100).toFixed(1) + '%',
      muito_longo_count: muitoLongoCount,
      muito_longo_pct: ((muitoLongoCount / total) * 100).toFixed(1) + '%',
    },
    cost: {
      total_usd: parseFloat(custoTotal.toFixed(4)),
      avg_usd: parseFloat((custoTotal / total).toFixed(6)),
    },
    latency_ms: {
      avg: latencyAvg ? Math.round(latencyAvg) : null,
      p95: latencyP95,
    },
    distribution_tier: porTier,
    distribution_intent: porIntent,
  };
}

module.exports = {
  checkMessage,
  aggregate,
  ANTI_PADROES_TOM,
  SAUDACAO_REGEX,
  DISCLOSURE_REGEX,
  NOME_MEL_REGEX,
  EM_DASH_REGEX,
  HIFEN_FAKE_DASH_REGEX,
};
