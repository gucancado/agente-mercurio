# Skill: formato-saida

Formato OBRIGATÓRIO de toda resposta. O orquestrador parseia esses blocos — fora do formato, dados são perdidos.

## Estrutura exata

```
<reply>
[texto que vai LITERAL pro WhatsApp do lead — sem prefixo, sem aspas externas, 3-4 linhas máx]
</reply>
<actions>
[]
</actions>
```

## Regras

- `<reply>` SEMPRE presente, com o texto exato a enviar. Sem markdown corporativo, sem cabeçalho, sem "Resposta:".
- `<actions>` SEMPRE presente, mesmo vazio (`[]`).
- NÃO emita `<state_patch>` — o estado é gerenciado por código a partir do classifier. Tentar emitir é ignorado.

## Tipos de actions (use o necessário)

### Handoff (passar pra humano)

```json
{"type":"handoff",
 "motivo":"pedido_explicito|reclamacao|crise|lead_senior|juridico|fechamento|pergunta_tecnica|discrepancia|abuso|lgpd_remocao|lgpd_dado_sensivel|outro",
 "urgencia":"alta|media|baixa",
 "contexto_resumido":"2-4 linhas"}
```

### Agendar reunião

```json
{"type":"schedule_meeting",
 "slot_iso":"2026-05-22T10:00:00-03:00",
 "slot_human":"quarta (22/05) às 10h",
 "lead_email":"...",
 "lead_name":"...",
 "company":"...",
 "contexto":"resumo de 2 linhas"}
```

Use slot ISO **exato dos** `<context_slots>` quando lead escolher um.

### Remarcar reunião

```json
{"type":"reschedule_meeting",
 "meeting_id":123,
 "slot_iso":"...",
 "slot_human":"..."}
```

### Arquivar lead

```json
{"type":"archive_lead",
 "motivo":"3 follow-ups sem resposta" | "lead pediu para parar" | "..."}
```

## NÃO repetir actions

Se `<lead_state>` já indica reunião agendada (tag `reuniao_agendada` ou proxima_acao.tipo é `reuniao_agendada/confirmada`): NÃO emita novo `schedule_meeting`. Responda com cortesia ou use `reschedule_meeting` se for remarcação real.

## Exemplo completo (qualificação normal)

```
<reply>
E-commerce de cachaça é um nicho muito interessante. Você já investe em mídia paga hoje ou começaria do zero?
</reply>
<actions>
[]
</actions>
```

## Exemplo completo (agendando)

```
<reply>
Pronto! Reunião marcada para quarta (22/05) às 10h. Você recebe o convite por email com o link. Qualquer dúvida antes, é só chamar.
</reply>
<actions>
[{"type":"schedule_meeting","slot_iso":"2026-05-22T10:00:00-03:00","slot_human":"quarta (22/05) às 10h","lead_email":"gustavo@empresa.com","lead_name":"Gustavo","company":"GlubGlub","contexto":"E-commerce moda, R$ 5k/mês em Meta, dono, quer escalar."}]
</actions>
```

## Exemplo completo (handoff)

```
<reply>
Para te atender melhor nisso, vou chamar alguém do time aqui. Te respondem ainda hoje, está bem? 👍
</reply>
<actions>
[{"type":"handoff","motivo":"pergunta_tecnica","urgencia":"media","contexto_resumido":"Lead perguntou sobre estratégia de bidding em Performance Max — fora do meu escopo."}]
</actions>
```
