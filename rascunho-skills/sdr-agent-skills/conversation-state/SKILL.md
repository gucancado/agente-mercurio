---
name: conversation-state
description: Define como o agente raciocina sobre o estado da conversa — temperatura do lead (frio/morno/quente), próxima ação, janelas de follow-up, critério de "esfriou", quando arquivar. Use sempre que o agente precisar decidir "o que faço agora com esse lead", quando uma mensagem chegar após silêncio prolongado, quando o lead sumir após interação, ou quando precisar planejar follow-ups proativos. Esta skill é o "cérebro temporal" do agente — diz o que fazer entre uma mensagem e a próxima.
---

# Estado e gerenciamento temporal da conversa

Um SDR humano bom não responde só ao que chega — **planeja o que vai chegar**. Esta skill define como o agente classifica leads, planeja follow-ups e decide quando desistir.

## Temperaturas do lead

Toda conversa tem um estado de temperatura, calculado a cada interação:

### 🔥 Quente
- Lead respondeu nas últimas 24h **e** já passou na qualificação (`sdr-qualification`).
- Próxima ação: marcar reunião AGORA (ver `meeting-scheduling`).
- Se ainda não marcou: agente proativamente propõe horário.

### ♨️ Morno
- Lead respondeu nos últimos 7 dias mas ainda não passou a qualificação completa.
- OU: lead já marcou reunião mas ela ainda não aconteceu.
- Próxima ação: continuar qualificação OU manter rapport até a reunião.

### ❄️ Frio
- Lead respondeu mas perdeu o ritmo (>7 dias sem resposta).
- OU: lead pediu pra ser contatado depois.
- Próxima ação: follow-up programado.

### 🧊 Congelado
- 3+ tentativas de follow-up sem resposta.
- OU: lead explicitamente disse "não tenho interesse".
- Próxima ação: arquivar. Reabrir só por trigger externo.

## Quando o agente envia mensagem proativa (sem o lead falar primeiro)

Em geral, **o agente prefere reagir a iniciar**. Mas tem 5 momentos legítimos pra mandar mensagem sem ser provocado:

### 1. Follow-up após silêncio (lead morno → frio)
Quando o lead parou de responder no meio de uma qualificação ou negociação.

**Cadência:**
- **D+2** (2 dias após última mensagem do lead): toque leve, sem cobrança.
  > "Oi [nome], passando pra ver se você teve um tempo de pensar. Qualquer dúvida é só chamar 👍"
- **D+7** (7 dias depois): tentativa de reengajamento com valor.
  > "Oi [nome], lembrei de você. Saiu [conteúdo/case relevante do nicho dele]. Quer dar uma olhada? Se fizer sentido a gente conversa."
- **D+21** (3 semanas depois): última tentativa, tom de "sem pressão".
  > "Oi [nome], última vez que te chamo por aqui pra não encher o saco. Se voltar a fazer sentido aí, sabe onde me achar 👍"

Depois disso, lead vai pra 🧊 congelado.

### 2. Lembrete de reunião (D-1)
Manhã do dia anterior à reunião marcada. Sempre. **Reduz no-show em ~40%.**
> "Oi [nome], lembrete da nossa call amanhã às [hora]. Tá de pé?"

### 3. Lembrete de reunião (D-0, opcional)
1h antes da reunião, **só se for a primeira reunião** com aquele lead.
> "Oi! Daqui a 1h nossa conversa. Link: [URL]"

### 4. Pós-reunião (se a reunião aconteceu)
30 min após a reunião acabar, agradecimento curto. **Não vender mais nada nessa mensagem.**
> "Valeu pela conversa, [nome]. Como falamos, te mando [próximo passo combinado]. Qualquer dúvida tá comigo aqui."

### 5. Reativação de lead congelado por trigger externo
Se o sistema indicar que o lead voltou a engajar (visitou site, abriu email, novo produto da agência relevante pro nicho dele), pode mandar mensagem **uma vez**:
> "Oi [nome], tudo bem? Lembrei de você por causa de [trigger genérico, sem expor tracking]. Faz sentido a gente voltar a conversar?"

## O que o agente NUNCA faz proativamente

- ❌ Mandar bom dia / boa tarde diário.
- ❌ Mandar conteúdo aleatório sem contexto ("olha esse vídeo que tá bombando!").
- ❌ Mandar 2 mensagens proativas em menos de 48h.
- ❌ Mandar follow-up depois das 21h ou antes das 9h.
- ❌ Mandar follow-up no domingo (sábado de manhã pode, com moderação).
- ❌ Mandar mais de 3 follow-ups sem resposta — depois disso, arquivar.

## Janela de "silêncio normal"

Não interpretar silêncio curto como rejeição:
- **< 4h:** lead pode estar ocupado, não é silêncio.
- **4h–24h:** silêncio neutro, sem ação.
- **24h–48h:** primeira reflexão sobre próximo passo (mas geralmente não age ainda).
- **2-3 dias:** primeiro follow-up legítimo (D+2).
- **> 7 dias:** lead esfriou — entra na cadência de reengajamento.

## Persistência de estado

A cada interação, o agente atualiza (via tool `update_lead_state`):

```
{
  "lead_id": "...",
  "temperatura": "quente|morno|frio|congelado",
  "qualificacao": {
    "B": "ok|fraco|desconhecido",
    "A": "ok|fraco|desconhecido",
    "N": "ok|fraco|desconhecido",
    "T": "ok|fraco|desconhecido"
  },
  "fatos_coletados": {
    "nome": "...",
    "empresa": "...",
    "nicho": "...",
    "email": "...",
    "investimento_atual": "...",
    "dor_declarada": "...",
    "decisor": "lead|outro|compartilhado"
  },
  "proxima_acao": {
    "tipo": "responder|aguardar|follow_up|marcar_reuniao|arquivar",
    "agendada_para": "ISO datetime ou null",
    "motivo": "texto curto"
  },
  "tentativas_followup": 0,
  "ultima_interacao": "ISO datetime",
  "tags": ["ja_tem_agencia", "fora_do_horario_comercial", ...]
}
```

Antes de responder qualquer mensagem nova, o agente **lê** esse estado via `get_conversation_context` pra ter histórico e contexto. Sem isso, vira amnésico.

## Critérios de arquivamento (lead vai pra 🧊)

Arquivar quando QUALQUER um:
- 3 follow-ups sem resposta.
- Lead disse explicitamente "não tenho interesse" / "para de me mandar mensagem".
- Lead claramente fora do ICP e já foi recusado uma vez.
- Lead bloqueou (se o canal sinalizar).
- 60+ dias sem qualquer interação.

Lead arquivado **não** recebe mais mensagem automática. Reabertura só via trigger humano ou trigger explícito do sistema.

## Critérios de reabertura de lead arquivado

- Lead manda nova mensagem espontaneamente → reabre como ♨️ morno.
- Trigger humano (operador da BeeAds marca pra reabrir).
- Trigger de produto/lançamento relevante pro nicho dele (com moderação — máximo 1x a cada 6 meses).

## Casos especiais

### Lead voltou depois de 2 meses sumido
Tratar como conversa nova mas com contexto:
> "Oi [nome], que bom ter notícias! Continua tocando [empresa] aí? Mudou algo de lá pra cá?"

Não cobrar ("você sumiu!", "tava te esperando!"). Apenas retomar.

### Lead já é cliente (passou pelo funil antes)
Se o sistema indicar que é cliente atual ou ex-cliente, **não tratar como lead novo**. Pedir pra passar pra humano via `flag_for_human` com contexto "lead já é/foi cliente — verificar tratamento adequado".

### Conflito entre estado salvo e mensagem nova do lead
Se o lead manda mensagem que contradiz o estado salvo (ex.: estado diz "lead disse que tem orçamento", lead agora diz "não tenho verba"), o agente **acredita na mensagem mais recente** e atualiza o estado. Não confronta o lead com inconsistência ("mas você disse antes que tinha verba!").
