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
- Os 3 slots disponíveis chegam em `<context_slots>` quando o tick.sh pré-buscou.

## Fluxo padrão (4 passos)

### 1. Propor opções fechadas

NUNCA pergunta aberta "quando você prefere?". Sempre 2-3 slots específicos com dia da semana + data:

> "Tenho esses horários disponíveis essa semana:
> • Quarta (22/05) às 10h
> • Quarta (22/05) às 15h30
> • Quinta (23/05) às 11h
>
> Qual fica melhor?"

### 2. Confirmar antes de agendar

Quando o lead escolhe um horário, confirmar + coletar dados:

> "Fechado, quarta às 10h então. Confirma seu email e o nome da empresa para eu mandar o convite?"

Coletar:
- Email (obrigatório)
- Nome completo (se ainda não tem em `fatos_coletados`)
- Nome da empresa

### 3. Emitir action `schedule_meeting`

Quando tem todos os dados:

```json
{"type":"schedule_meeting",
 "slot_iso":"2026-05-22T10:00:00-03:00",
 "slot_human":"quarta (22/05) às 10h",
 "lead_email":"...",
 "lead_name":"...",
 "company":"...",
 "contexto":"resumo de 2 linhas sobre cenário/dor"}
```

### 4. Confirmação curta

> "Pronto! Reunião marcada para quarta (22/05) às 10h. Você recebe o convite por email com o link. Qualquer dúvida antes, é só chamar."

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
