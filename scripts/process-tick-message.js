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

// Mapeamento de canal por projeto. Define qual transport usar pra cada projeto.
// JSON no formato:
//   {
//     "metido-a-gente": { "provider": "cloud", "phone_number_id": "1152130677980438" },
//     "outro-projeto": { "provider": "evolution", "instance": "mercurio-outro-projeto" }
//   }
// Default (não listado): provider=evolution, instance=`<agent>-<slug>` (vem do inbox.instance).
let CHANNEL_PROVIDERS = {};
try {
  CHANNEL_PROVIDERS = JSON.parse(process.env.CHANNEL_PROVIDERS_JSON || '{}');
} catch (e) {
  console.error('CHANNEL_PROVIDERS_JSON inválido:', e.message);
}

if (!WORKER_URL || !WORKER_TOKEN) {
  console.error('env faltando: WORKER_URL / WORKER_TOKEN');
  process.exit(2);
}
// Evolution credentials são opcionais agora (só necessárias se algum projeto usa provider=evolution)
if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
  console.warn('AVISO: EVOLUTION_API_URL/EVOLUTION_API_KEY não setadas. Projetos que usam provider=evolution vão falhar.');
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

async function cloudSendText(phoneNumberId, to, text) {
  const url = `${WORKER_URL}/send-cloud`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'X-Agent-Token': WORKER_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ phone_number_id: phoneNumberId, to: to.replace(/^\+/, ''), text }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`worker POST /send-cloud HTTP ${r.status} body=${body.slice(0, 200)}`);
  }
  return r.json();
}

/**
 * Envia mensagem WhatsApp pelo canal configurado pro projeto.
 * Retorna { send_id?: string } no padrão.
 *
 * @param {object} ctx — { projectSlug, instance, identifier, text }
 */
async function channelSendText(ctx) {
  const { projectSlug, instance, identifier, text } = ctx;
  const cfg = CHANNEL_PROVIDERS[projectSlug] || { provider: 'evolution', instance };
  const provider = cfg.provider || 'evolution';

  if (provider === 'cloud') {
    if (!cfg.phone_number_id) {
      throw new Error(`channel cloud sem phone_number_id pra projeto ${projectSlug}`);
    }
    const resp = await cloudSendText(cfg.phone_number_id, identifier, text);
    return { send_id: resp?.send_id ?? null, provider: 'cloud' };
  }

  // default: evolution
  const evoInstance = cfg.instance || instance;
  const resp = await evolutionSendText(evoInstance, identifier.replace(/^\+/, ''), text);
  return { send_id: resp?.key?.id ?? null, provider: 'evolution' };
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

const CLASSIFIER_SYSTEM = `Você é o classificador de mensagens recebidas pelo agente de WhatsApp. Contexto específico do projeto (persona, função, ICP) vem no payload de cada chamada via project_brief.

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
  const identity = `Você é um representante da equipe BeeAds (agência de marketing digital).
Responde mensagens de WhatsApp de prospects interessados em tráfego pago.
Sua função: qualificar leads via BANT e agendar reuniões com o time comercial.

Regras de identidade obrigatórias:
- Apresente-se como "equipe BeeAds" ou "time BeeAds". NUNCA use o nome interno técnico (ver PROJECT.md) no texto enviado ao lead.
- NÃO use o caractere em-dash "—" (U+2014) nem hífen-com-espaços " - " em nenhuma resposta. Use vírgulas, ponto, parênteses ou dois-pontos.
- NÃO mencione proativamente que é IA, agente automatizado, robô, ou software. Só revele isso se o lead PERGUNTAR diretamente ("você é robô?", "é IA?", "é humano?").
- Quando perguntado se é IA: responda honestamente "Sim, sou um agente da equipe BeeAds, operado por humanos. Se preferir falar direto com uma pessoa, é só pedir."
- NUNCA exponha nome próprio do diretor. Sempre "o time comercial" ou "nosso time".

Palavras e expressões PROIBIDAS (substitua SEMPRE antes de gerar <reply>):
- "a gente" → "nós" / "somos" / "estamos" / "o time" / "a equipe BeeAds"
- "tá"/"tô" → "está"/"estou"
- "pra" → "para"
- "beleza" → "certo" / "perfeito" / (omitir)
- "rola" → "é interessante" / "trabalhamos bastante com"
- "show" → "ótimo" / (omitir)
- "tranquilo" (como ok) → "sem problema" / "claro"
Antes de emitir <reply>, releia o texto. Se contém qualquer palavra acima, reescreva.

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
  const { channel, identifier, projectSlug } = ctx;
  if (!action || !action.type) return;

  // ?project=<slug> ativa o backend real (Google Calendar) no worker.
  // Sem ele, o worker fica no path legacy (simulated_meetings mock).
  const projectQs = projectSlug ? `?project=${encodeURIComponent(projectSlug)}` : '';

  if (action.type === 'handoff') {
    await workerPost('/handoff', {
      channel, identifier,
      motivo: action.motivo || 'outro',
      urgencia: action.urgencia || 'media',
      contexto_resumido: action.contexto_resumido || '',
    });
  } else if (action.type === 'schedule_meeting') {
    await workerPost(`/meetings/schedule${projectQs}`, {
      channel, identifier,
      slot_iso: action.slot_iso,
      slot_human: action.slot_human,
      lead_email: action.lead_email,
      lead_name: action.lead_name,
      company: action.company,
      contexto: action.contexto,
      // worker em /meetings/schedule decide path real (Google) vs legacy
      // (simulated_meetings) pela presença de body.project — não pela
      // querystring. Sem isso TUDO cai em fallback simulated.
      project: projectSlug || undefined,
    });
  } else if (action.type === 'reschedule_meeting') {
    await workerPost(`/meetings/${action.meeting_id}/reschedule${projectQs}`, {
      slot_iso: action.slot_iso,
      slot_human: action.slot_human,
      project: projectSlug || undefined,
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

  // Esperado: ou { id, ... } (legacy single) ou { ids: [...], ... } (grouped).
  // Em modo grouped, message_text já vem concatenado pelo worker. Mark-read
  // usa todos os ids do grupo no final.
  const inboxIds = Array.isArray(item.ids) && item.ids.length
    ? item.ids.map((n) => parseInt(n, 10))
    : (item.id != null ? [parseInt(item.id, 10)] : []);
  if (inboxIds.length === 0) {
    console.error('process-tick-message: item sem id nem ids');
    process.exit(2);
  }
  const inboxId = inboxIds[inboxIds.length - 1]; // mais recente, pra logging
  const channel = item.channel || 'whatsapp';
  const instance = item.instance;
  const identifier = item.identifier;
  const text = item.message_text || '(sem texto)';
  const pushName = item.push_name || '?';
  const projectSlug = instance.split('-').slice(1).join('-');
  const projectDir = path.join(WORKSPACE, 'projetos', projectSlug);

  // Toggle de projeto: lê _platform/disabled-projects.json (gerenciado pela
  // console agentes-beeads). Se o projeto está na lista, NÃO responde —
  // apenas marca a inbox como processada e sai. Funciona como pausa segura
  // pra desativar atendimento em um único projeto sem mexer no agente todo.
  try {
    const disabledPath = path.join(WORKSPACE, '_platform/disabled-projects.json');
    if (fs.existsSync(disabledPath)) {
      const disabled = JSON.parse(fs.readFileSync(disabledPath, 'utf8'))?.disabled || [];
      if (Array.isArray(disabled) && disabled.includes(projectSlug)) {
        await postDebug(`[${inboxId}] projeto ${projectSlug} pausado via disabled-projects.json — skip`);
        try {
          await workerPost('/inbox-debug/mark-read', { ids: inboxIds, processed_by: 'process-tick-paused' });
        } catch {}
        console.log(JSON.stringify({ ok: true, skipped: true, reason: 'project_disabled', project: projectSlug }));
        return;
      }
    }
  } catch (err) {
    await postDebug(`[${inboxId}] falha ao ler disabled-projects: ${err.message?.slice(0, 120)}`);
  }

  const groupTag = inboxIds.length > 1 ? ` (group=${inboxIds.length})` : '';
  await postDebug(`[${inboxId}]${groupTag} processando from=${identifier} project=${projectSlug}: ${text.slice(0, 60)}`);

  // Curto-circuito: mensagem chegou sem texto (áudio, sticker, formato exótico
  // que o parser não cobriu). NÃO invocar LLM — pedir reenvio em texto e marcar
  // como processada. Mantém custo zero e evita o agente improvisar resposta sem
  // contexto.
  if (!item.message_text || item.message_text.trim() === '') {
    const askText = 'Não consegui ler sua última mensagem (pode ter chegado em formato não suportado). Pode reenviar como texto, por favor?';
    try {
      await channelSendText({ projectSlug, instance, identifier, text: askText });
      await workerPost('/messages', {
        channel, identifier, direction: 'outbound', text: askText,
        tier: 'baixo', classifier_intent: 'sem_texto',
      });
      await postDebug(`[${inboxId}] sem texto recebido; pediu reenvio (curto-circuito sem LLM)`);
    } catch (err) {
      await postDebug(`[${inboxId}] sem texto — falhou ao pedir reenvio: ${(err).message?.slice?.(0, 200)}`);
    }
    await workerPost('/inbox-debug/mark-read', { ids: inboxIds, processed_by: 'process-tick-no-text' });
    console.log(JSON.stringify({ ok: true, sem_texto: true, cost_usd_total: 0 }));
    return;
  }

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

  // ── 2. Pre-fetch slots com CACHE no lead_state ──
  // PROBLEMA HISTÓRICO (slot drift, fix 2026-05-30): /meetings/suggest-slots é
  // stateful — cada chamada cria 3 holds tentativos no Google Calendar. Se
  // chamarmos a cada tick, holds antigos viram "ocupado" e a função retorna
  // slots cada vez mais tardios. O Haiku lê o <context_slots> mais recente e
  // responde horário diferente do que o lead escolheu → drift.
  //
  // SOLUÇÃO: cachear os slots oferecidos no lead_state. Re-buscar SÓ quando:
  //   (a) não temos cache (slots_oferecidos vazio/ausente) OU
  //   (b) cache está stale (>10min) OU
  //   (c) o lead já escolheu um slot e queremos refresh pra próxima rodada
  //       de agendamento (não cobre aqui — schedule_meeting consome o cache).
  const SLOTS_TTL_MS = 10 * 60 * 1000;
  const cachedSlots = Array.isArray(leadState.slots_oferecidos) ? leadState.slots_oferecidos : [];
  const cachedAt = leadState.slots_oferecidos_at ? Date.parse(leadState.slots_oferecidos_at) : 0;
  const cacheFresh = cachedSlots.length > 0 && (Date.now() - cachedAt) < SLOTS_TTL_MS;

  let slotsPromise;
  let usedCachedSlots = false;
  if (cacheFresh) {
    usedCachedSlots = true;
    slotsPromise = Promise.resolve({ slots: cachedSlots, source: 'cache' });
  } else {
    const slotsUrl =
      `/meetings/suggest-slots?project=${encodeURIComponent(projectSlug)}` +
      `&channel=${encodeURIComponent(channel)}` +
      `&identifier=${encodeURIComponent(identifier)}`;
    slotsPromise = workerGet(slotsUrl).catch((err) => {
      postDebug(`[${inboxId}] suggest-slots falhou: ${err.message?.slice(0, 200)}`).catch(() => {});
      return { slots: [] };
    });
  }

  // ── 3. Classifier (em paralelo com pré-fetch de slots) ──
  const classifierModel = pickClassifierModel(projectDir);
  let classification;
  let classifierMetric;
  let contextSlots = [];
  let slotsSource = null;
  try {
    const req = buildClassifierRequest({ leadMessage: text, leadState, model: classifierModel });
    const [classifierResp, slotsResp] = await Promise.all([complete(req), slotsPromise]);
    classification = classifierResp.result;
    classifierMetric = classifierResp;
    contextSlots = Array.isArray(slotsResp?.slots) ? slotsResp.slots : [];
    slotsSource = slotsResp?.source || null;
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
    `[${inboxId}] classifier: intent=${classification.intent} trigger=${classification.trigger_critico} complex=${classification.complexidade} cost=$${classifierMetric.cost_usd.toFixed(6)} cache_r=${classifierMetric.cache_read_tokens} slots=${contextSlots.length}(${slotsSource ?? 'none'}) cached=${usedCachedSlots}`
  );

  // ── 4. Aplica fatos_novos + BANT + slots no lead_state ──
  const statePatch = {};

  // slot_escolhido_iso é separado de fatos_coletados — é estado top-level que
  // serve pra blindar o orquestrador contra o Haiku errar o slot na action.
  // Só aceitamos se bater LITERALMENTE com um dos slots oferecidos.
  let slotEscolhido = null;
  if (classification.fatos_novos) {
    const fn = { ...classification.fatos_novos };
    if (fn.slot_escolhido_iso) {
      const candidato = fn.slot_escolhido_iso;
      const offered = Array.isArray(contextSlots) ? contextSlots : [];
      const match = offered.find((s) => s && s.iso === candidato);
      if (match) {
        slotEscolhido = match; // {iso, human, ...}
        statePatch.slot_escolhido_iso = match.iso;
        statePatch.slot_escolhido_human = match.human;
      } else {
        await postDebug(`[${inboxId}] classifier devolveu slot_escolhido_iso=${candidato} mas não bate com offered=${offered.map(s=>s.iso).join('|')} — ignorando`);
      }
      delete fn.slot_escolhido_iso; // não vai pra fatos_coletados
    }
    if (Object.keys(fn).length) {
      statePatch.fatos_coletados = {
        ...(leadState.fatos_coletados || {}),
        ...fn,
      };
    }
  }
  if (classification.atualizacao_bant && Object.keys(classification.atualizacao_bant).length) {
    statePatch.qualificacao = {
      ...(leadState.qualificacao || {}),
      ...classification.atualizacao_bant,
    };
  }
  // Se acabamos de buscar slots novos do worker, persiste no cache do state.
  if (!usedCachedSlots && contextSlots.length > 0) {
    statePatch.slots_oferecidos = contextSlots;
    statePatch.slots_oferecidos_at = new Date().toISOString();
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

    await channelSendText({ projectSlug, instance, identifier, text: replyText });
    const msgRow = await workerPost('/messages', {
      project: projectSlug,
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
      ids: inboxIds,
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
  // Delay randômico anti-detecção do WhatsApp (Baileys = unofficial).
  // Configurável via env vars; default = OFF (delay zero) pra não atrapalhar
  // testes. Em "produção real" recomendado: MIN=3000 MAX=15000 (3-15s).
  const delayMinMs = parseInt(process.env.RESPONSE_DELAY_MIN_MS || '0', 10);
  const delayMaxMs = parseInt(process.env.RESPONSE_DELAY_MAX_MS || '0', 10);
  if (delayMaxMs > delayMinMs && delayMaxMs > 0) {
    const delay = delayMinMs + Math.floor(Math.random() * (delayMaxMs - delayMinMs));
    await postDebug(`[${inboxId}] delay anti-detecção: ${delay}ms`);
    await new Promise((r) => setTimeout(r, delay));
  }

  let evoSendId = null;
  let sendProvider = 'unknown';
  try {
    const sendResp = await channelSendText({ projectSlug, instance, identifier, text: reply });
    evoSendId = sendResp?.send_id || null;
    sendProvider = sendResp?.provider || 'unknown';
  } catch (err) {
    await postDebug(`[${inboxId}] sendText FALHOU: ${err.message.slice(0, 200)}`);
    process.exit(6);
  }
  await postDebug(`[${inboxId}] enviado via ${sendProvider} send_id=${evoSendId ?? '(null)'}`);

  // ── 8. INSERT messages (outbound) + llm_metrics do responder ──
  const totalCost = classifierMetric.cost_usd + respResp.cost_usd;
  const msgOut = await workerPost('/messages', {
    project: projectSlug,
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
    // Defesa anti-slot-drift: se temos um slot_escolhido_iso travado no state
    // (que veio do classifier batendo com slots oferecidos) E o LLM emitiu
    // schedule_meeting com slot diferente, FORÇA o slot do state. Protege
    // contra o Haiku ler context_slots novos e escolher horário diferente do
    // que o lead aprovou.
    if (action && action.type === 'schedule_meeting' && leadState.slot_escolhido_iso) {
      if (action.slot_iso !== leadState.slot_escolhido_iso) {
        await postDebug(
          `[${inboxId}] slot override: LLM enviou slot_iso=${action.slot_iso} mas state.slot_escolhido_iso=${leadState.slot_escolhido_iso} — forçando o do state`
        );
        action.slot_iso = leadState.slot_escolhido_iso;
        if (leadState.slot_escolhido_human) action.slot_human = leadState.slot_escolhido_human;
      }
    }
    try { await applyAction(action, { channel, identifier, projectSlug }); }
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
    // Limpa o cache de slots — a reunião foi marcada, qualquer reschedule
    // futuro deve buscar slots frescos.
    postStatePatch.slots_oferecidos = [];
    postStatePatch.slots_oferecidos_at = null;
    postStatePatch.slot_escolhido_iso = null;
    postStatePatch.slot_escolhido_human = null;
  } else if (actions.some((a) => a.type === 'handoff')) {
    postStatePatch.proxima_acao = { tipo: 'handoff_solicitado', motivo: 'aguardando humano' };
  } else {
    postStatePatch.proxima_acao = { tipo: 'responder', motivo: `pós ${classification.intent}` };
  }
  if (Object.keys(postStatePatch).length) {
    await workerPost('/lead-state', { channel, identifier, patch: postStatePatch });
  }

  // ── 11. Marca inbox como processado (todos do grupo) ──
  await workerPost('/inbox-debug/mark-read', {
    ids: inboxIds,
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
