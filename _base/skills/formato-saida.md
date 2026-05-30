# Skill: formato-saida

Formato OBRIGATÓRIO de toda resposta. O orquestrador parseia esses blocos; fora do formato, dados são perdidos.

## Estrutura exata

```
<reply>
[texto que vai LITERAL pro WhatsApp do lead. Sem prefixo, sem aspas externas, 3-4 linhas máx. PROIBIDO usar o caractere em-dash "—" no texto.]
</reply>
<actions>
[]
</actions>
```

## Regras

- `<reply>` SEMPRE presente, com o texto exato a enviar. Sem markdown corporativo, sem cabeçalho, sem "Resposta:".
- `<actions>` SEMPRE presente, mesmo vazio (`[]`).
- NÃO emita `<state_patch>`. O estado é gerenciado por código a partir do classifier. Tentar emitir é ignorado.

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
 "slot_iso":"<iso literal do slot escolhido em <context_slots>>",
 "slot_human":"<human literal do slot escolhido em <context_slots>>",
 "lead_email":"gustavo@clinicavitalite.com.br",
 "lead_name":"Gustavo Cançado",
 "company":"Clínica Vitalité",
 "contexto":"resumo de 2 linhas"}
```

- `lead_email` = email do lead.
- `lead_name` = **nome da pessoa** com quem você conversa (primeiro + sobrenome quando disponível).
- `company` = **nome da empresa/negócio** que ela representa. NUNCA repita o nome da pessoa aqui. Se não souber a empresa, pergunte antes de emitir a action — não chute, não use o nicho ("clínica médica") como substituto.

Use os valores `iso` e `human` **literais** do slot escolhido em `<context_slots>`. NUNCA invente datas.

**Quando emitir `schedule_meeting`** (checklist obrigatório):
1. Há slot escolhido (lead respondeu confirmando um dos slots oferecidos em `<context_slots>`).
2. Há `lead_email` válido (do próprio lead, nesta thread).
3. Há `lead_name` (pessoa) — vem de `fatos_coletados.nome` ou da conversa.
4. Há `company` (empresa) — nome próprio do negócio, NÃO nicho.

Se faltar qualquer item, peça o que falta na `<reply>` e emita `<actions>[]`. Se tem todos os 4, emita `schedule_meeting` **na mesma resposta** em que confirma — NÃO escreva "vou passar pro time" sem a action; isso quebra o fluxo.

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

Assuma que `<context_slots>` chegou com `[{ iso: "<ISO>", human: "<HUMAN>", ... }, ...]` e o lead escolheu o primeiro:

```
<reply>
Pronto! Reunião marcada para <HUMAN>. Você recebe o convite por email com o link. Qualquer dúvida antes, é só chamar.
</reply>
<actions>
[{"type":"schedule_meeting","slot_iso":"<ISO>","slot_human":"<HUMAN>","lead_email":"gustavo@glubglub.com.br","lead_name":"Gustavo Mendes","company":"GlubGlub Cachaças","contexto":"E-commerce moda, R$ 5k/mês em Meta, dono, quer escalar."}]
</actions>
```

Substitua `<ISO>` e `<HUMAN>` pelos campos `iso` e `human` literais do slot que o lead escolheu — sem ajustar formato, sem traduzir, sem inventar.

## Exemplo completo (handoff)

```
<reply>
Para te atender melhor nisso, vou chamar alguém do time aqui. Te respondem ainda hoje, está bem? 👍
</reply>
<actions>
[{"type":"handoff","motivo":"pergunta_tecnica","urgencia":"media","contexto_resumido":"Lead perguntou sobre estratégia de bidding em Performance Max (fora do meu escopo)."}]
</actions>
```
