/**
 * client.mjs — camada de acesso ao worker para o tooling de conversas.
 *
 * Lê credenciais de secrets/.env.local (WORKER_URL, WORKER_AGENT_TOKEN) e
 * expõe fetchers tipados. Sem dependências externas — usa fetch nativo (Node ≥20).
 *
 * O endpoint GET /messages do worker NÃO filtra por project/since — devolve as
 * últimas N por agent (DESC). Filtro de tempo/projeto é feito client-side aqui.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, '../../secrets/.env.local');

/** Loader minimalista de .env (sem dep dotenv). Ignora comentários e linhas vazias. */
function loadEnv() {
  let raw;
  try {
    raw = readFileSync(ENV_PATH, 'utf-8');
  } catch {
    throw new Error(
      `Não achei ${ENV_PATH}. Crie com WORKER_URL e WORKER_AGENT_TOKEN ` +
        `(derive do Coolify: app worker → env AGENT_TOKENS_JSON.mercurio.worker_token).`
    );
  }
  const env = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}

const env = loadEnv();
const WORKER_URL = process.env.WORKER_URL || env.WORKER_URL;
const TOKEN = process.env.WORKER_AGENT_TOKEN || env.WORKER_AGENT_TOKEN;

if (!WORKER_URL || !TOKEN) {
  throw new Error('WORKER_URL ou WORKER_AGENT_TOKEN ausentes em secrets/.env.local');
}

async function get(path) {
  const r = await fetch(`${WORKER_URL}${path}`, {
    headers: { 'X-Agent-Token': TOKEN },
  });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 300);
    throw new Error(`GET ${path} → HTTP ${r.status}: ${body}`);
  }
  return r.json();
}

/** Converte "24h" | "7d" | "90m" em Date de corte (ou null se vazio/"all"). */
export function parseSince(s) {
  if (!s || s === 'all') return null;
  const m = /^(\d+)\s*([mhd])$/.exec(s.trim());
  if (!m) throw new Error(`--since inválido: "${s}" (use ex: 90m, 24h, 7d, ou all)`);
  const n = Number(m[1]);
  const ms = { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
  return new Date(Date.now() - n * ms);
}

/**
 * Busca mensagens. since/identifier/direction filtrados client-side quando o
 * endpoint não suporta. limitFetch = teto bruto puxado antes do filtro de tempo.
 */
export async function getMessages({ since, identifier, direction, limitFetch = 500 } = {}) {
  const qs = new URLSearchParams({ limit: String(limitFetch) });
  if (identifier) qs.set('identifier', identifier);
  if (direction) qs.set('direction', direction);
  const { messages } = await get(`/messages?${qs}`);
  const cutoff = since instanceof Date ? since : parseSince(since);
  const filtered = cutoff ? messages.filter((m) => new Date(m.created_at) >= cutoff) : messages;
  // endpoint devolve DESC; trabalhar cronológico é mais natural pra análise
  return filtered.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

export async function getMeetings({ status = 'all', limit = 100 } = {}) {
  const qs = new URLSearchParams({ status, limit: String(limit) });
  const { meetings } = await get(`/meetings?${qs}`);
  return meetings;
}

export async function getMetrics({ since = '7d' } = {}) {
  return get(`/metrics/summary?since=${encodeURIComponent(since)}`);
}

export { WORKER_URL };
