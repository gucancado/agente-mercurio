#!/usr/bin/env node
/**
 * zerar-reply.js — envia a confirmação "Conversa zerada..." pelo canal
 * configurado do projeto (Cloud API ou Evolution), igual o orquestrador faz.
 *
 * Chamado por tick.sh dentro do bloco de comando mágico zerar-conversa.
 * Lê JSON do stdin: { projectSlug, instance, identifier, text }
 *
 * Sai com 0 se enviou; 1 + stderr se falhou.
 */

const WORKER_URL = process.env.WORKER_URL;
const WORKER_TOKEN = process.env.WORKER_TOKEN;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;

let CHANNEL_PROVIDERS = {};
try {
  CHANNEL_PROVIDERS = JSON.parse(process.env.CHANNEL_PROVIDERS_JSON || '{}');
} catch (e) {
  console.error('CHANNEL_PROVIDERS_JSON inválido:', e.message);
  process.exit(2);
}

async function cloudSendText(phoneNumberId, to, text) {
  const r = await fetch(`${WORKER_URL}/send-cloud`, {
    method: 'POST',
    headers: { 'X-Agent-Token': WORKER_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ phone_number_id: phoneNumberId, to: to.replace(/^\+/, ''), text }),
  });
  if (!r.ok) throw new Error(`worker /send-cloud HTTP ${r.status} body=${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function evolutionSendText(instance, number, text) {
  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
    throw new Error('EVOLUTION_API_URL/KEY não setadas — projeto requer canal evolution');
  }
  const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${instance}`, {
    method: 'POST',
    headers: { 'apikey': EVOLUTION_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ number, text }),
  });
  if (!r.ok) throw new Error(`evolution sendText HTTP ${r.status}`);
  return r.json();
}

async function main() {
  const stdin = await new Promise((resolve) => {
    let buf = '';
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
  });
  const { projectSlug, instance, identifier, text } = JSON.parse(stdin);
  const cfg = CHANNEL_PROVIDERS[projectSlug] || { provider: 'evolution', instance };
  const provider = cfg.provider || 'evolution';

  if (provider === 'cloud') {
    if (!cfg.phone_number_id) throw new Error(`channel cloud sem phone_number_id pra projeto ${projectSlug}`);
    await cloudSendText(cfg.phone_number_id, identifier, text);
  } else {
    await evolutionSendText(cfg.instance || instance, identifier.replace(/^\+/, ''), text);
  }
  console.log(JSON.stringify({ ok: true, provider }));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
