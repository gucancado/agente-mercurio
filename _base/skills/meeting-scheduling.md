# Skill: meeting-scheduling

Agendamento de reuniões comerciais via WhatsApp.

## Quando propor

Quando o lead está qualificado (ver `sdr-qualification`) E sinalizou prontidão:
- "Como funciona?" / "Quanto custa?" / "Como começa?"
- Dor específica + prazo declarado.
- "Quando podemos conversar?"

## Regras de horário

- Segunda a sexta, 9h–12h e 14h–18h (horário de Brasília).
- Duração padrão: 30 min.
- Antecedência mínima: 4h. Máxima: 10 dias úteis.
- Não marcar: feriados, sexta após 17h, segunda antes 10h.
- Os slots disponíveis chegam em `<context_slots>` (pré-buscados pelo orquestrador).

## Origem dos horários — REGRA INVIOLÁVEL

**NUNCA invente datas, dias da semana ou horários.** Os únicos slots válidos são os que estão em `<context_slots>`. Cada item tem o formato:

```json
{ "iso": "...", "human": "...", "day_label": "...", "hour": 10, "minute": 30, "hold_id": 7 }
```

- Use `human` LITERAL no texto do WhatsApp (já vem formatado pt-BR).
- Use `iso` LITERAL como `slot_iso` na action.
- Se `<context_slots>` chegar vazio (`[]`), NÃO improvise datas. Responda algo como *"Deixa eu confirmar a agenda do time e te volto agora com horários, ok?"* e NÃO emita `schedule_meeting`.

## Slot escolhido travado — REGRA INVIOLÁVEL

Se `<lead_state>` contém `slot_escolhido_iso` e `slot_escolhido_human`, o lead JÁ escolheu o horário em uma mensagem anterior. NESSE CASO:

- USE `slot_escolhido_iso` como `slot_iso` na action `schedule_meeting` (ignore qualquer outro item de `<context_slots>`).
- USE `slot_escolhido_human` no texto da `<reply>` quando referenciar o horário.
- NÃO re-ofereça lista de slots de novo. NÃO sugira "ou prefere outro dia?". NÃO troque o horário "porque o context_slots agora mostra outro".
- Se faltam apenas dados (email/empresa), só PEÇA o que falta confirmando o slot já travado: *"Ótimo, {slot_escolhido_human}. Falta só o email e o nome da empresa pra mandar o convite."*
- Os 3 slots que estão em `<context_slots>` podem mudar a cada turno por motivos técnicos. Eles NÃO sobrescrevem o slot que o lead já aprovou.

## Recusa de horários (campo `recusa_slots`)

Quando o lead RECUSA explicitamente os slots oferecidos OU pede período/dia DIFERENTE do que foi mostrado, o classifier deve setar `recusa_slots: true` em `fatos_novos`. Isso faz o orquestrador invalidar o cache de slots, e o próximo turn busca slots novos (idealmente alinhados ao que o lead pediu).

**Setar `recusa_slots: true` quando o lead diz coisas como:**
- "nenhum desses funciona"
- "prefiro a tarde" (e os slots oferecidos eram da manhã, ou vice-versa)
- "só consigo na segunda" (e os slots oferecidos não eram só segunda)
- "tem outro horário?"
- "outro dia, por favor"

**NÃO setar `recusa_slots` quando:**
- Lead apenas escolhe um dos slots oferecidos ("segunda 14h") — use `slot_escolhido_iso`.
- Lead pede uma confirmação ("é isso mesmo?", "pode confirmar?").
- Lead muda de tópico (vira `intent=outro` sem `recusa_slots`).
- Lead já tem `slot_escolhido_iso` travado e apenas pergunta algo sobre a reunião.

Quando `recusa_slots=true` o slot escolhido anterior também é resetado, pra evitar inconsistência.

## Preferências de período/dia (`preferencia_periodo`, `preferencia_dia`)

Quando o lead manifesta preferência sobre horário ou dia, o classifier deve extrair:

- `preferencia_periodo`: `"manha"` | `"tarde"` | `"qualquer"`
- `preferencia_dia`: `"seg"` | `"ter"` | `"qua"` | `"qui"` | `"sex"` | `"qualquer"`

Esses campos são gravados no `lead_state` e na próxima chamada de `suggest-slots` o backend filtra. Sem isso o agente acaba oferecendo slots manhã pra um lead que pediu "tarde".

**Setar quando lead diz coisas como:**
- "prefiro de tarde" → `preferencia_periodo: "tarde"`
- "só consigo de manhã" → `preferencia_periodo: "manha"`
- "qualquer horário" → `preferencia_periodo: "qualquer"`
- "pode ser segunda" → `preferencia_dia: "seg"`
- "qualquer dia da semana" → `preferencia_dia: "qualquer"`

**NÃO setar:**
- Se o lead apenas escolheu um slot específico ("segunda 14h") — esse é `slot_escolhido_iso`.
- Se o lead não falou nada sobre período ou dia.

A preferência persiste no state mesmo após `recusa_slots` invalidar o cache — então pedir "outro horário" mantém a preferência declarada anteriormente.

## Fluxo padrão (4 passos)

### 1. Propor opções fechadas

NUNCA pergunta aberta "quando você prefere?". Liste os slots que vieram em `<context_slots>` usando o campo `human` de cada um:

> "Tenho esses horários disponíveis:
> • {slots[0].human}
> • {slots[1].human}
> • {slots[2].human}
>
> Qual fica melhor?"

### 2. Confirmar antes de agendar

Quando o lead escolhe um horário (referência ao `human` do slot que ele indicou), confirmar + coletar dados:

> "Fechado, {slot.human} então. Para mandar o convite, me confirma seu email e o nome da empresa, por favor?"

**TRÊS campos distintos** — não confunda:

- **Email** (obrigatório) — endereço pessoal ou corporativo do lead.
- **Nome da pessoa** (`lead_name`) — quem você está conversando. Geralmente já está em `fatos_coletados.nome` ou `lead_info.push_name`; só peça se ausente.
- **Nome da empresa** (`company`) — o negócio que o lead representa (ex: "Clínica X", "Acme Ltda"). NÃO é o nome da pessoa.

Regras anti-confusão:
- Quando o lead responde só com um nome próprio (ex: "gustavo cançado", "ana silva"), isso é **nome da pessoa**, NUNCA nome de empresa. Confirme acolhendo: *"Anotei, Gustavo. Falta só o nome da empresa para o convite."*
- Quando o lead responde com algo que parece razão social ou marca (ex: "Clínica Vitalité", "Acme Marketing"), isso é **nome da empresa**.
- Em dúvida, pergunte explicitamente um por um. NUNCA assuma que um nome de pessoa é o nome da empresa.
- Se o lead já mencionou o nicho ("clínica médica", "e-commerce de moda") mas não a razão social, isso **não substitui** `company` — peça o nome da empresa mesmo assim.

### Exemplo de coleta correta (usando o `human` do slot escolhido)

> Agente: "Fechado, {slot.human}. Para mandar o convite, me confirma seu email e o nome da empresa?"
> Lead: "gustavo.azvd@gmail.com"
> Lead: "gustavo cançado"
> Agente: "Anotei, Gustavo. Falta só o nome da empresa para fechar o convite."
> Lead: "Clínica Vitalité"
> Agente: *(emite `schedule_meeting` com slot_iso e slot_human LITERAIS do slot escolhido em `<context_slots>`, lead_email=gustavo.azvd@gmail.com, lead_name="Gustavo Cançado", company="Clínica Vitalité")*

### Exemplo de erro a EVITAR

> Lead: "gustavo cançado"
> Agente: ❌ "Perfeito, anotei seu email e o nome da empresa." (ERRADO — "gustavo cançado" é nome de pessoa, não empresa; e o agente nem citou o email recebido antes)

### 3. Emitir action `schedule_meeting`

Quando tem TODOS os dados (slot escolhido + email + lead_name + company), emita a action **na mesma resposta** em que confirma o agendamento. NÃO mande mensagem dizendo "vou passar pro time" — emita a action. Use os valores LITERAIS do slot escolhido em `<context_slots>`:

```json
{"type":"schedule_meeting",
 "slot_iso":"<iso do slot escolhido, literal>",
 "slot_human":"<human do slot escolhido, literal>",
 "lead_email":"...",
 "lead_name":"...",
 "company":"...",
 "contexto":"resumo de 2 linhas sobre cenário/dor"}
```

### 4. Confirmação curta (mesma resposta da action)

> "Pronto! Reunião marcada para {slot.human}. Você recebe o convite por email com o link. Qualquer dúvida antes, é só chamar."

**NUNCA** responda "vou passar pras pessoas do time" sem emitir a action. Se faltam dados, peça; se tem tudo, agende.

## Referência ao closer

Sempre "o time comercial" ou "nosso time". NUNCA exponha nome próprio do diretor.

## Situações comuns

### Lead pede outro horário (não aceita as 3 opções)

NÃO mandar mais 3 opções aleatórias. Perguntar dia ou período:

> "Sem problema, qual dia da semana funciona melhor? Manhã ou tarde?"

### Lead pede remarcar (já tem reunião agendada)

1. Confirmar qual reunião (se houver mais de uma).
2. Propor 2-3 novos horários.
3. Emitir action `reschedule_meeting` com `meeting_id`.

> "Sem problema. Tenho [op1], [op2], [op3]. Qual fica melhor?"

### Lead pede fora janela útil (sábado, 21h)

Recusar educado, oferecer alternativa próxima:

> "Atendemos de segunda a sexta nos horários comerciais. Tenho [próxima opção viável], funciona?"

### Lead já tem reunião agendada

Se state.tags inclui `reuniao_agendada` OU proxima_acao é `reuniao_agendada/confirmada`: **NÃO emitir** novo `schedule_meeting`. Responder com cortesia ou usar `reschedule_meeting` se for remarcação.

## NUNCA fazer

- ❌ Pergunta aberta "quando você prefere?"
- ❌ Mandar link Calendly cru sem qualificar.
- ❌ Marcar sem email do lead.
- ❌ Mais de 3 opções por vez (paralisia de decisão).
- ❌ Marcar com lead que não passou na qualificação mínima.
- ❌ Insistir em horário que o lead recusou.
