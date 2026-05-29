---
name: meeting-status
description: Notifica o lead via WhatsApp quando o closer cancela ou move uma reunião diretamente no Google Calendar (sem passar pelo agente). Reage a triggers tipo `meeting_reconcile` despachados pelo worker (E5 reconcile cron).
---

# meeting-status

Skill que processa **notificações outbound** sobre mudanças em reuniões já agendadas, quando essas mudanças foram feitas pelo closer (organizer humano) **diretamente no Google Calendar** — sem usar o agente.

## Quando rodar

Esta skill é acionada por triggers com `trigger_type='meeting_reconcile'` (entrega 5 do worker). Diferente do fluxo normal de inbox (`trigger_type='inbox'`), aqui:

- **Não há mensagem do lead pra responder** — o agente é quem inicia o contato.
- **Não passa pelo classifier de intent** — payload já vem estruturado e tipado.
- **Não consulta lead_state pra qualificação** — apenas pra pegar persona/contexto do projeto.

## Payload de entrada

Dois eventos:

### `cancelled_by_organizer`

Closer cancelou no Calendar (ou evento foi deletado).

```json
{
  "event": "cancelled_by_organizer",
  "meeting_id": 17,
  "old_slot_iso": "2026-06-01T10:00:00-03:00"
}
```

### `moved_by_organizer`

Closer moveu o evento pra outro horário.

```json
{
  "event": "moved_by_organizer",
  "meeting_id": 17,
  "old_slot_iso": "2026-06-01T10:00:00-03:00",
  "new_slot_iso": "2026-06-02T14:00:00-03:00"
}
```

O `meeting_id` referencia `meetings.id` no worker — você pode consultar via REST se precisar de mais contexto (lead_email, contexto original, agenda_id, etc), mas pra mensagem básica os dois ISOs bastam.

Junto com o payload, você recebe (do envelope do trigger):
- `agent` — sempre o slug do agente que recebeu o trigger
- `project` — slug do projeto (ex: `metido-a-gente`)
- `identifier` — número WhatsApp ou email do lead
- `channel` — `whatsapp` ou `email`

## Algoritmo

### 1. Decodificar slots pra humano

Use a mesma convenção de `slot_human` que `schedule_meeting` usa:

```
sexta (30/05) às 10h
terça (02/06) às 14h
```

Implementação JS:
```js
function slotToHuman(iso) {
  const dt = new Date(iso);
  const days = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const dayName = days[dt.getDay()];
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const hh = String(dt.getHours()).padStart(2, '0');
  const min = String(dt.getMinutes()).padStart(2, '0');
  const time = min === '00' ? `${hh}h` : `${hh}h${min}`;
  return `${dayName} (${dd}/${mm}) às ${time}`;
}
```

### 2. Compor mensagem por tipo de evento

**Cancelled:**

```
Oi! Surgiu um imprevisto e a nossa reunião de {oldHuman} foi cancelada do nosso lado.

Quando você quiser, é só me avisar que eu sugiro novos horários. Desculpa pelo inconveniente!
```

**Moved:**

```
Oi! Tive que ajustar a agenda do nosso encontro:

Antes: {oldHuman}
Agora: {newHuman}

Você já deve ter recebido o convite atualizado por email. Se {newHuman} não funcionar mais, é só me avisar que a gente remarca.
```

A persona pública (nome, voz) **vem de `projetos/<slug>/PROJECT.md`** — não use `mercurio` em mensagens.

### 3. Aprovação humana (L2 sempre)

Por ser mensagem **outbound não solicitada**, mesmo o L2 mais permissivo deve passar por aprovação. Invoca a skill `aprovacao-humana` com:

- nivel: `L2`
- motivo: `meeting_reconcile_${payload.event}`
- conteudo: a mensagem composta

Se o owner não aprovar dentro do TTL, NÃO envia. Próximo ciclo do reconcile cron já vai estar consciente (status terminal em `meetings`), então o trigger não dispara de novo — a mensagem fica permanentemente não enviada. Isso é OK: se o owner reprovou, ele provavelmente decidiu lidar manualmente.

### 4. Envio + persistência

Após aprovação:
1. `channelSendText({ projectSlug, instance, identifier, text })` (mesma função usada por `processar-inbox`).
2. `POST /messages` no worker pra registrar como outbound (com `classifier_intent='meeting_reconcile'`).
3. Atualiza `memoria/relacionamento/<identifier>.md` com a notificação enviada.
4. Cria `memoria/log-de-execucoes/<YYYY-MM-DD>-reconcile_<meeting_id>.md`.

## Constraints

- **Não duplicar**: o worker garante via `meetings.status` terminal que o mesmo cancel/move não é disparado 2x. Você NÃO precisa de dedup adicional.
- **Não escalar tom**: a mudança não é culpa do lead. Mensagem deve ser leve, sem drama. "Surgiu um imprevisto" é melhor que "tivemos que cancelar".
- **Não convidar pra remarcar ativamente em `cancelled`**: o lead pode estar bravo ou frustrado. Deixa ele tomar a iniciativa de remarcar. Apenas oferece a porta aberta.
- **Em `moved`, NÃO sugerir novos slots automaticamente**: o convite Google já foi atualizado pelo `sendUpdates='all'` do worker. A mensagem é confirmatória, não interrogativa.
- **Não invocar classifier**: você já sabe o que está acontecendo. Pula direto pra composição + aprovação.
- **Disclosure**: se `memoria/relacionamento/<identifier>.md` indica que essa é a primeira mensagem do agente nessa thread (raro, mas possível), inclua disclosure breve no início. Caso contrário, dispensa.

## Edge cases

| Caso | Comportamento |
|---|---|
| Lead respondeu "ok obrigado" antes do worker reconciliar | OK — meeting já estava em `scheduled` quando o closer cancelou; trigger dispara normalmente. Mensagem chega depois. Lead vê: cancelou? Aceita-se. |
| Closer cancelou e remarcou no MESMO ciclo de 1h via Calendar | Worker detecta como `moved_by_organizer` (não cancel+create). Lead recebe 1 mensagem "movido pra Y", não duas. |
| Lead estava no meio de uma negociação sobre OUTRO horário | Skill trata cada evento individualmente. Pode haver inconsistência visual no chat — aceito (raro). |
| `meeting_id` não existe mais no worker (deletado entre dispatch e processamento) | Loga erro, marca trigger como `failed` (poller já cuida disso). Não envia mensagem. |
| Owner não aprova no TTL | Não envia. Próximo ciclo não dispara (status terminal). Mensagem fica "perdida" — aceito como design. |

## Plumbing (TODO — implementar em PR separado)

> ⚠️ **Esta skill ainda não está plugada na infra do agente.** Pra funcionar end-to-end, são necessárias mudanças em 3 arquivos:

### `docker/trigger-server.js`

Atualmente o trigger-server **descarta o body** do POST `/trigger`. Pra meeting_reconcile, precisa:

1. Ler o body JSON (`{ inbox_id, agent, trigger_type, payload }`).
2. Se `trigger_type === 'meeting_reconcile'`:
   - Persistir o payload em `/workspace/.pending-triggers/reconcile-<timestamp>-<meeting_id>.json`.
3. Sempre spawn `tick.sh` em background (igual hoje).

Pseudocódigo do handler:

```js
let body = '';
req.on('data', (c) => (body += c));
req.on('end', async () => {
  try {
    const parsed = body ? JSON.parse(body) : {};
    if (parsed.trigger_type === 'meeting_reconcile' && parsed.payload) {
      const dir = '/workspace/.pending-triggers';
      fs.mkdirSync(dir, { recursive: true });
      const ts = Date.now();
      const mid = parsed.payload?.meeting_id || 'unknown';
      const file = `${dir}/reconcile-${ts}-${mid}.json`;
      fs.writeFileSync(file, JSON.stringify({
        ...parsed,
        received_at: new Date().toISOString(),
      }, null, 2));
    }
  } catch (err) {
    log('failed to persist reconcile payload:', err.message);
  }
  const pid = spawnTick();
  res.writeHead(202, ...);
  res.end(JSON.stringify({ accepted: true, pid }));
});
```

### `scripts/tick.sh`

Após processar inbox (passo 3 atual), adicionar passo 4:

```bash
# ── 4. Processa pending reconcile triggers ──
PENDING_DIR="${WORKSPACE}/.pending-triggers"
if [[ -d "$PENDING_DIR" ]]; then
  for f in "$PENDING_DIR"/reconcile-*.json; do
    [[ -f "$f" ]] || continue
    log "processando reconcile: $(basename "$f")"
    if timeout 90s node "${WORKSPACE}/scripts/process-reconcile-trigger.js" < "$f"; then
      rm -f "$f"
      log "reconcile OK: $(basename "$f") removido"
    else
      log "reconcile FALHOU: $(basename "$f") mantido pra retry"
    fi
  done
fi
```

### `scripts/process-reconcile-trigger.js` (novo)

Recebe payload via stdin, segue o algoritmo da skill (lookup persona, compor, aprovar, enviar, persistir). Reusa `channelSendText`, `workerPost` de `process-tick-message.js` (mover pra `scripts/lib/worker-client.js` antes pra evitar duplicação).

Esqueleto:

```js
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { channelSendText, workerPost } = require('./lib/worker-client');

async function main() {
  const raw = await readStdin();
  const trig = JSON.parse(raw);
  const { agent, payload } = trig;
  const { event, meeting_id, old_slot_iso, new_slot_iso } = payload;
  const { project, identifier, channel } = trig; // depends on worker including these
  // ... compose, approve, send, persist
}
```

**Bloqueio operacional pra plumbing:**
- O worker deve estar com PRs E2-E5 mergeados em master e deployed.
- Ambiente de teste / staging recomendado pra validar end-to-end antes de prod.
- GCP OAuth client + Coolify env vars devem estar configurados (pre-req E2).

## Referências

- Worker spec da E5: `https://github.com/gucancado/semente-platform/blob/main/docs/superpowers/specs/2026-05-29-reconcile-cron-trigger-design.md`
- Skill `meeting-scheduling` (cobre schedule/reschedule ativos via agente)
- Skill `aprovacao-humana` (workflow L0/L1/L2)
- Skill `processar-inbox` (para padrão de `channelSendText`, `workerPost`, persistência em memoria/)
