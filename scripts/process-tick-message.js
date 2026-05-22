#!/usr/bin/env node
/**
 * process-tick-message.js — orquestrador de 1 mensagem (Fase 2 do plano).
 *
 * Lê uma mensagem da inbox via stdin (JSON do worker /inbox-debug) e:
 *
 *   1. Lê lead_state via REST
 *   2. (Pre-fetch) suggest_slots se state indica agendar
 *   3. CALL 1 — Classifier (structured JSON: intent, trigger, complexidade, fatos, BANT)
 *      → INSERT llm_metrics
 *   4. Aplica fatos_novos + atualizacao_bant em lead_state
 *   5. Decide handoff vs continuar
 *   6. CALL 2 — Responder (Haiku v1, tier_baixo/medio/alto na Fase 4)
 *      → texto puro com <reply> e <actions>
 *      → INSERT llm_metrics
 *   7. Envia via Evolution sendText
 *   8. INSERT messages (outbound) + atualiza llm_metrics com message_id
 *   9. Aplica actions (handoff, schedule_meeting, archive_lead)
 *  10. UPDATE lead_state (temperatura, proxima_acao a partir do classifier)
 *  11. Marca inbox como processado
 *
 * Saída na stdout: JSON `{ ok, cost_usd_total, classifier_intent, tier, reply_preview }`.
 *
 * Erros: stderr + exit 1. tick.sh trata.
 */

const fs = require('node:fs');
const path = require('node:path');
const { complete } = require('./llm-adapter');
const { loadSkillsForIntent } = require('./skills-loader');

const WORKSPACE = '/workspace';
const CLASSIFIER_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(WORKSPACE, '_base/schemas/classifier.json'), 'utf8')
);

// ── env ─────────────────────────────────────────────────────────────────

const WORKER_URL = process.env.WORKER_URL;
const WORKER_TOKEN = process.env.WORKER_TOKEN;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;

if (!WORKER_URL || !WORKER_TOKEN || !EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
  console.error('env faltando: WORKER_URL / WORKER_TOKEN / EVOLUTION_API_URL / EVOLUTION_API_KEY');
  process.exit(2);
}

// ── REST helpers ────────────────────────────────────────────────────────

async function workerGet(pathQ) {
  const url = `${WORKER_URL}${pathQ}`;
  const r = await fetch(url, { headers: { 'X-Agent-Token': WORKER_TOKEN } });
  if (!r.ok) throw new Error(`worker GET ${pathQ} HTTP ${r.status}`);
  return r.json();
}

async function workerPost(pathQ, body) {
  const url = `${WORKER_URL}${pathQ}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'X-Agent-Token': WORKER_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`worker POST ${pathQ} HTTP ${r.status} body=${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function evolutionSendText(instance, number, text) {
  const url = `${EVOLUTION_API_URL}/message/sendText/${instance}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'apikey': EVOLUTION_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ number, text }),
  });
  if (!r.ok) throw new Error(`evolution sendText HTTP ${r.status}`);
  return r.json();
}

// ── Model config (Fase 2: tudo Haiku; tier routing entra na Fase 4) ─────

function pickClassifierModel(_projectDir) {
  // Pode ser sobrescrito futuramente via projetos/<slug>/llm-config.yml
  return 'claude-haiku-4-5';
}

// Mapping default tier → modelo. Override por projeto via llm-config.yml
// (não implementado ainda — entra com config-driven na evolução pós-v1).
const TIER_TO_MODEL = {
  baixo:  'claude-haiku-4-5',
  medio:  'claude-haiku-4-5',
  alto:   'claude-sonnet-4-6',
};

function pickResponderModel(projectDir, tier) {
  // Override legado: arquivo MODEL na pasta do projeto (1 linha, força modelo
  // único pra TODOS os tiers — útil pra testes A/B simples). Quando existir,
  // ignora o tier routing.
  try {
    const modelFile = path.join(projectDir, 'MODEL');
    if (fs.existsSync(modelFile)) {
      const m = fs.readFileSync(modelFile, 'utf8').trim().split('\n')[0].trim();
      if (m) return m;
    }
  } catch {}
  return TIER_TO_MODEL[tier] || 'claude-haiku-4-5';
}

/**
 * Tier routing — decide qual tier de modelo usar com base na classificação
 * e no estado do lead. Roda em código, sem custo LLM.
 *
 * Regras (Fase 4):
 *   - intent saudacao_inicial/escolha_horario/confirmacao → tier_baixo (Haiku)
 *   - intent objecao OU complexidade alta → tier_alto (Sonnet)
 *   - tentativas_followup >= 2 → tier_alto (lead difícil, vale modelo melhor)
 *   - default → tier_medio (Haiku)
 *
 * Triggers críticos e pedido_humano já curto-circuitam ANTES desta função
 * (handoff), então não tratam aqui.
 */
function escolherTier(classification, leadState) {
  const intent = classification.intent;
  const complexidade = classification.complexidade;
  const tentativasFollowup = leadState?.tentativas_followup || 0;

  if (intent === 'saudacao_inicial' || intent === 'escolha_horario' || intent === 'confirmacao') {
    return 'baixo';
  }
  if (intent === 'objecao') {
    return 'alto';
  }
  if (complexidade === 'alta') {
    return 'alto';
  }
  if (tentativasFollowup >= 2) {
    return 'alto';
  }
  return 'medio';
}

// ── Prompt builders ─────────────────────────────────────────────────────

const CLASSIFIER_SYSTEM = `Você é o classificador da Mel, agente SDR da BeeAds.

Sua única tarefa: analisar uma mensagem do lead + estado salvo, e devolver JSON estruturado seguindo o schema.

- intent: o que a mensagem É (saudação? resposta de qualificação? objeção?)
- trigger_critico: detectar situações que exigem humano (crise, abuso, reclamação, LGPD, fechamento)
- complexidade: trivial (saudação/confirmação curta) | normal (qualificação) | alta (objeção, ambiguidade)
- fatos_novos: extrair nome, empresa, email, nicho, investimento mensal — APENAS o que a mensagem revela
- atualizacao_bant: B (orçamento), A (autoridade), N (necessidade), T (timing). "ok" se a mensagem confirma, "fraco" se confirma negativamente, omitir se silenciosa.

NÃO gere texto livre. NÃO explique. Devolva só o JSON via tool_use.`;

function buildClassifierRequest({ leadMessage, leadState, model }) {
  const stateText = JSON.stringify(leadState, null, 2);
  return {
    task: 'classify',
    model,
    maxTokens: 1024,
    temperature: 0.2,
    system: [{ text: CLASSIFIER_SYSTEM, cache: true }],
    messages: [
      {
        role: 'user',
        content: `<lead_state>\n${stateText}\n</lead_state>\n\n<lead_message>\n${leadMessage}\n</lead_message>\n\nClassifique a mensagem.`,
      },
    ],
    responseSchema: CLASSIFIER_SCHEMA,
  };
}

function buildResponderRequest({
  leadMessage,
  leadState,
  classification,
  contextSlots,
  isFirstMessage,
  projectBrief,
  skillsText,
  leadInfo,
  model,
  tier,
}) {
  // Identidade — pequena, máximo cacheável
  const identity = `Você é a Mel, SDR da BeeAds (agência de marketing digital).
Responde mensagens de WhatsApp de prospects interessados em tráfego pago.
Sua função: qualificar leads via BANT e agendar reuniões com o time comercial.
Nunca exponha nome próprio do diretor — refira-se sempre como "o time comercial" ou "nosso time".

Cada chamada carrega um subset de skills relevantes ao intent classificado.
Siga as regras das skills carregadas. Em caso de conflito: ética/LGPD vence outras.`;

  // Contexto dinâmico (NÃO cacheado)
  const contextoBlocks = [
    `<is_first_message>${isFirstMessage}</is_first_message>`,
    `<lead_state>\n${JSON.stringify(leadState, null, 2)}\n</lead_state>`,
    `<classification>\n${JSON.stringify(classification, null, 2)}\n</classification>`,
    `<context_slots>\n${JSON.stringify(contextSlots)}\n</context_slots>`,
    `<lead_info>\n${JSON.stringify(leadInfo)}\n</lead_info>`,
    `<project_brief>\n${projectBrief}\n</project_brief>`,
    `<lead_message>\n${leadMessage}\n</lead_message>`,
    `\nResponda no formato definido na skill formato-saida.`,
  ];

  return {
    task: `respond_${tier}`,
    model,
    maxTokens: 2048,
    temperature: 0.6,
    system: [
      { text: identity, cache: true },        // breakpoint #1 (sempre cacheado)
      { text: skillsText, cache: true },      // breakpoint #2 (cacheado por combinação de skills)
    ],
    messages: [
      { role: 'user', content: contextoBlocks.join('\n\n') },
    ],
  };
}

// ── Parser do output do responder ───────────────────────────────────────

function parseResponderOutput(text) {
  const reply = (text.match(/<reply>([\s\S]*?)<\/reply>/) || [])[1]?.trim() || '';
  const actionsRaw = (text.match(/<actions>([\s\S]*?)<\/actions>/) || [])[1]?.trim() || '[]';
  let actions = [];
  try {
    actions = JSON.parse(actionsRaw);
    if (!Array.isArray(actions)) actions = [];
  } catch {
    actions = [];
  }
  // Fallback: se não tem <reply>, usa output inteiro
  return { reply: reply || text.trim(), actions };
}

// ── Action handlers ─────────────────────────────────────────────────────

async function applyAction(action, ctx) {
  const { channel, identifier } = ctx;
  if (!action || !action.type) return;

  if (action.type === 'handoff') {
    await workerPost('/handoff', {
      channel, identifier,
      motivo: action.motivo || 'outro',
      urgencia: action.urgencia || 'media',
      contexto_resumido: action.contexto_resumido || '',
    });
  } else if (action.type === 'schedule_meeting') {
    await workerPost('/meetings/schedule', {
      channel, identifier,
      slot_iso: action.slot_iso,
      slot_human: action.slot_human,
      lead_email: action.lead_email,
      lead_name: action.lead_name,
      company: action.company,
      contexto: action.contexto,
    });
  } else if (action.type === 'reschedule_meeting') {
    await workerPost(`/meetings/${action.meeting_id}/reschedule`, {
      slot_iso: action.slot_iso,
      slot_human: action.slot_human,
    });
  } else if (action.type === 'archive_lead') {
    await workerPost('/lead-state', {
      channel, identifier,
      patch: {
        temperatura: 'congelado',
        proxima_acao: { tipo: 'arquivar', motivo: action.motivo || 'archive_lead' },
      },
    });
  }
}

// ── Main ────────────────────────────────────────────────────────────────

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

async function postDebug(text) {
  try {
    await workerPost('/debug', { source: 'process-tick', text });
  } catch {}
}

async function main() {
  const raw = await readStdin();
  const item = JSON.parse(raw);

  // Esperado: { id, channel, instance, identifier, message_text, push_name }
  const inboxId = item.id;
  const channel = item.channel || 'whatsapp';
  const instance = item.instance;
  const identifier = item.identifier;
  const text = item.message_text || '(sem texto)';
  const pushName = item.push_name || '?';
  const projectSlug = instance.split('-').slice(1).join('-');
  const projectDir = path.join(WORKSPACE, 'projetos', projectSlug);

  await postDebug(`[${inboxId}] processando from=${identifier} project=${projectSlug}: ${text.slice(0, 60)}`);

  if (!fs.existsSync(projectDir)) {
    console.error(`projeto ${projectSlug} não existe em ${projectDir}`);
    process.exit(3);
  }
  const projectBrief = fs.readFileSync(path.join(projectDir, 'PROJECT.md'), 'utf8');

  // ── 1. Lê lead_state ──
  const stateResp = await workerGet(
    `/lead-state?channel=${encodeURIComponent(channel)}&identifier=${encodeURIComponent(identifier)}`
  );
  const leadState = stateResp.state || {};
  const isFirstMessage = !stateResp.exists;

  // ── 2. Pre-fetch slots se quente ou marcando ──
  let contextSlots = [];
  const proximaTipo = leadState?.proxima_acao?.tipo || '';
  const temp = leadState?.temperatura || '';
  if (proximaTipo.includes('marcar') || proximaTipo.includes('reuniao') || temp === 'quente') {
    try {
      const slotsResp = await workerGet('/meetings/suggest-slots');
      contextSlots = slotsResp.slots || [];
    } catch {}
  }

  // ── 3. Classifier ──
  const classifierModel = pickClassifierModel(projectDir);
  let classification;
  let classifierMetric;
  try {
    const req = buildClassifierRequest({ leadMessage: text, leadState, model: classifierModel });
    const resp = await complete(req);
    classification = resp.result;
    classifierMetric = resp;
  } catch (err) {
    await postDebug(`[${inboxId}] classifier falhou: ${err.message.slice(0, 200)}`);
    // Registra erro nas métricas mas segue com classification minimal
    await workerPost('/llm-metrics', {
      task: 'classify', provider: 'anthropic', model: classifierModel,
      error: err.message.slice(0, 500),
    });
    process.exit(4);
  }

  await postDebug(
    `[${inboxId}] classifier: intent=${classification.intent} trigger=${classification.trigger_critico} complex=${classification.complexidade} cost=$${classifierMetric.cost_usd.toFixed(6)} cache_r=${classifierMetric.cache_read_tokens}`
  );

  // ── 4. Aplica fatos_novos + BANT no lead_state ──
  const statePatch = {};
  if (classification.fatos_novos && Object.keys(classification.fatos_novos).length) {
    statePatch.fatos_coletados = {
      ...(leadState.fatos_coletados || {}),
      ...classification.fatos_novos,
    };
  }
  if (classification.atualizacao_bant && Object.keys(classification.atualizacao_bant).length) {
    statePatch.qualificacao = {
      ...(leadState.qualificacao || {}),
      ...classification.atualizacao_bant,
    };
  }
  if (Object.keys(statePatch).length) {
    await workerPost('/lead-state', { channel, identifier, patch: statePatch });
    Object.assign(leadState, statePatch); // reflete localmente pro responder ver
  }

  // Registra métrica do classifier
  const classifierMetricRow = await workerPost('/llm-metrics', {
    task: 'classify',
    provider: classifierMetric.provider,
    model: classifierMetric.model,
    tokens_in: classifierMetric.tokens_in,
    tokens_out: classifierMetric.tokens_out,
    cache_read_tokens: classifierMetric.cache_read_tokens,
    cache_write_tokens: classifierMetric.cache_write_tokens,
    cost_usd: classifierMetric.cost_usd,
    latency_ms: classifierMetric.latency_ms,
    cache_hit: classifierMetric.cache_read_tokens > 0,
  });

  // ── 5. Handoff curto-circuita responder ──
  if (classification.trigger_critico !== 'nenhum' || classification.intent === 'pedido_humano') {
    const motivo = classification.trigger_critico !== 'nenhum' ? classification.trigger_critico : 'pedido_humano';
    const replyText = motivo === 'fechamento'
      ? 'Ótimo! Para isso já te conecto com o time comercial. Te chamam aqui ainda hoje.'
      : 'Para te atender melhor nisso, vou chamar alguém do time aqui. Te respondem ainda hoje, está bem? 👍';

    await evolutionSendText(instance, identifier.replace(/^\+/, ''), replyText);
    const msgRow = await workerPost('/messages', {
      channel, identifier, direction: 'outbound', text: replyText,
      tier: 'handoff', classifier_intent: classification.intent,
    });
    await workerPost('/handoff', {
      channel, identifier,
      motivo,
      urgencia: motivo === 'crise' || motivo === 'abuso' ? 'alta' : 'media',
      contexto_resumido: `Trigger=${classification.trigger_critico} intent=${classification.intent}. Mensagem: ${text.slice(0, 200)}`,
    });
    await workerPost('/inbox-debug/mark-read', {
      id: parseInt(inboxId, 10),
      processed_by: 'process-tick',
    });
    console.log(JSON.stringify({
      ok: true, handoff: true, classifier_intent: classification.intent,
      cost_usd_total: classifierMetric.cost_usd, reply_preview: replyText.slice(0, 80),
    }));
    return;
  }

  // ── 6. Responder ──
  const tier = escolherTier(classification, leadState);
  const responderModel = pickResponderModel(projectDir, tier);
  await postDebug(`[${inboxId}] tier routing: ${tier} → model=${responderModel}`);

  // Skills modulares (Fase 3): carrega só as relevantes ao intent classificado.
  // Ordem alfabética → cache key estável → cache hit em chamadas com mesma
  // combinação de skills.
  const { names: skillsLoaded, text: skillsText } = loadSkillsForIntent(classification.intent);
  await postDebug(`[${inboxId}] skills: ${skillsLoaded.join(', ')}`);

  const respReq = buildResponderRequest({
    leadMessage: text, leadState, classification, contextSlots,
    isFirstMessage, projectBrief, skillsText,
    leadInfo: { identifier, push_name: pushName, channel },
    model: responderModel,
    tier,
  });
  const respResp = await complete(respReq);
  const responderText = respResp.result;
  const { reply, actions } = parseResponderOutput(responderText);

  await postDebug(
    `[${inboxId}] responder tier=${tier} model=${responderModel} cost=$${respResp.cost_usd.toFixed(6)} cache_r=${respResp.cache_read_tokens}: ${reply.slice(0, 120)}`
  );

  if (!reply.trim()) {
    await postDebug(`[${inboxId}] responder reply vazia — pulando envio`);
    process.exit(5);
  }

  // ── 7. Envia via Evolution ──
  let evoSendId = null;
  try {
    const sendResp = await evolutionSendText(instance, identifier.replace(/^\+/, ''), reply);
    evoSendId = sendResp?.key?.id || null;
  } catch (err) {
    await postDebug(`[${inboxId}] sendText FALHOU: ${err.message.slice(0, 200)}`);
    process.exit(6);
  }

  // ── 8. INSERT messages (outbound) + llm_metrics do responder ──
  const totalCost = classifierMetric.cost_usd + respResp.cost_usd;
  const msgOut = await workerPost('/messages', {
    channel, identifier, direction: 'outbound', text: reply,
    evolution_send_id: evoSendId,
    tier, model: respResp.model, provider: respResp.provider,
    classifier_intent: classification.intent,
    cost_usd: respResp.cost_usd,
    latency_ms: respResp.latency_ms,
  });
  await workerPost('/llm-metrics', {
    message_id: parseInt(msgOut.id, 10),
    task: `respond_${tier}`,
    provider: respResp.provider, model: respResp.model, tier,
    tokens_in: respResp.tokens_in, tokens_out: respResp.tokens_out,
    cache_read_tokens: respResp.cache_read_tokens,
    cache_write_tokens: respResp.cache_write_tokens,
    cost_usd: respResp.cost_usd, latency_ms: respResp.latency_ms,
    cache_hit: respResp.cache_read_tokens > 0,
  });

  // ── 9. Aplica actions ──
  for (const action of actions) {
    try { await applyAction(action, { channel, identifier }); }
    catch (err) {
      await postDebug(`[${inboxId}] action ${action.type} falhou: ${err.message.slice(0, 200)}`);
    }
  }

  // ── 10. UPDATE lead_state com temperatura/proxima_acao a partir da classificação ──
  const postStatePatch = {};
  if (classification.intent === 'pergunta_servico' || classification.intent === 'qualificacao_resposta') {
    postStatePatch.temperatura = leadState.temperatura === 'congelado' ? 'morno' : (leadState.temperatura || 'morno');
  }
  if (actions.some((a) => a.type === 'schedule_meeting')) {
    postStatePatch.tags = Array.from(new Set([...(leadState.tags || []), 'reuniao_agendada']));
    postStatePatch.proxima_acao = { tipo: 'reuniao_agendada', motivo: 'agendamento confirmado' };
  } else if (actions.some((a) => a.type === 'handoff')) {
    postStatePatch.proxima_acao = { tipo: 'handoff_solicitado', motivo: 'aguardando humano' };
  } else {
    postStatePatch.proxima_acao = { tipo: 'responder', motivo: `pós ${classification.intent}` };
  }
  if (Object.keys(postStatePatch).length) {
    await workerPost('/lead-state', { channel, identifier, patch: postStatePatch });
  }

  // ── 11. Marca inbox como processado ──
  await workerPost('/inbox-debug/mark-read', {
    id: parseInt(inboxId, 10),
    processed_by: 'process-tick',
  });

  console.log(JSON.stringify({
    ok: true,
    classifier_intent: classification.intent,
    tier,
    actions: actions.map((a) => a.type),
    cost_usd_total: totalCost,
    reply_preview: reply.slice(0, 120),
  }));
}

main().catch((err) => {
  console.error(`process-tick-message error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
