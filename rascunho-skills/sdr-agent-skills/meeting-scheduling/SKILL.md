---
name: meeting-scheduling
description: Conduz o processo de agendar, confirmar, remarcar e cancelar reuniões comerciais via WhatsApp, integrando com Google Calendar. Use sempre que o lead estiver qualificado e pronto para marcar reunião, quando precisar propor horários, confirmar agendamento, lidar com pedidos de remarcação ou cancelamento, ou quando precisar lembrar o lead de uma reunião próxima. Aplica-se também quando o agente precisa lidar com fusos horários, conflitos de agenda, ou regras de buffer entre reuniões.
---

# Agendamento de reuniões comerciais

Esta skill cobre o momento mais delicado da operação SDR: transformar interesse em compromisso na agenda. O erro mais comum aqui é **perguntar "quando você prefere?"** — pergunta aberta mata conversão. Outro erro grave é **mandar link de Calendly genérico** logo de cara, sem ter validado fit. Esta skill prescreve um fluxo manual, conversado, com 3 opções fechadas.

## Regras de horário (defaults — podem ser sobrescritas por configuração do cliente)

- **Janela útil:** segunda a sexta, 9h–12h e 14h–18h (horário de Brasília).
- **Duração padrão:** 30 minutos para call de descoberta.
- **Buffer entre reuniões:** 15 minutos antes e depois (não marcar back-to-back).
- **Antecedência mínima:** 4 horas (não marcar para "daqui a 30 min", a não ser que o lead explicitamente peça e a agenda permita).
- **Antecedência máxima:** 10 dias úteis (se o lead pede algo mais longe, é sinal de baixa urgência — qualificar de novo).
- **Não marcar:** feriados nacionais BR, último horário da sexta (após 17h), primeiro horário da segunda (antes das 10h — buffer pra emergências).

## Fluxo de proposta de horário (o jeito certo)

Quando o lead estiver qualificado (ver `sdr-qualification`) e sinalizar pronto pra conversar:

### Passo 1 — Consultar agenda
Chamar a tool `suggest_meeting_slots` que retorna até 3 horários disponíveis aplicando todas as regras acima. Pedir slots para os **próximos 3 dias úteis** primeiro. Se o lead já sinalizou prazo apertado, pedir slots para os próximos 2 dias.

### Passo 2 — Propor com opções fechadas
Mandar **2 ou 3 opções específicas**, nunca pergunta aberta. Formato:

> "Tenho esses horários disponíveis essa semana:
> • Quarta (22/05) às 10h
> • Quarta (22/05) às 15h30
> • Quinta (23/05) às 11h
>
> Qual fica melhor pra você?"

**Nunca mandar mais de 3 opções** — paralisa decisão. **Nunca propor sem dia da semana e data** — "10h" sem contexto causa confusão.

### Passo 3 — Confirmar e criar evento
Quando o lead escolher um horário, **confirmar antes de criar**:

> "Fechado, quarta às 10h então. Vou agendar com link do Google Meet e te mando aqui o convite. Confirma seu email pra eu mandar o invite? E o nome da empresa pra eu colocar no convite?"

Coletar:
- **Email** (obrigatório — para o invite).
- **Nome completo do lead** (se ainda não tiver).
- **Nome da empresa** (para o título do evento).
- **Quem mais participa** (se já souber, adicionar como convidado).

Só depois disso chamar `create_meeting`.

### Passo 4 — Confirmar criação
Após criar o evento, mandar mensagem de confirmação curta com **data + hora + link do Meet**:

> "Pronto! Reunião marcada pra quarta (22/05) às 10h. Link do Meet: [URL]. Te mando lembrete no dia anterior. Qualquer coisa antes disso, é só chamar aqui."

## Título e descrição do evento (padrão)

**Título:** `BeeAds × [Nome da Empresa] — Conversa inicial`

**Descrição:**
```
Reunião comercial de descoberta.

Lead: [Nome do lead]
WhatsApp: [Número]
Empresa: [Nome]
Origem: [Como chegou — Instagram, indicação, busca, etc., se souber]

Contexto rápido:
- [Resumo de 2-3 bullets sobre dor declarada, investimento atual, urgência]

Próximos passos sugeridos para a call:
- Entender melhor o cenário atual
- Apresentar como a gente trabalha
- Definir se faz sentido proposta formal
```

## Lidando com situações comuns

### Lead pede outro horário (não aceita as 3 opções)
Não mandar mais 3 opções aleatórias. Perguntar **dia da semana ou período**:
> "Tranquilo, qual dia da semana funciona melhor? E prefere manhã ou tarde?"
Aí volta no passo 1 com filtro mais específico.

### Lead pede para remarcar (já tem reunião agendada)
1. Confirmar que entendeu qual reunião remarcar (se houver mais de uma).
2. Perguntar motivo brevemente (sem ser invasivo) — ajuda a qualificar engajamento.
3. Propor 2-3 novos horários.
4. Quando confirmado, chamar `reschedule_meeting` (não cancelar + criar novo — perde histórico).

> "Sem problema. Tenho [opção 1], [opção 2], [opção 3]. Qual fica melhor?"

**Importante:** se for 2ª remarcação seguida pelo mesmo lead, anotar no estado da conversa (`update_lead_state`) e flagar — pode ser sinal de baixo interesse.

### Lead cancela
Aceitar sem pressionar. Perguntar de leve se quer remarcar:
> "Sem problema, [nome]. Quer que a gente marque pra outra data ou prefere que eu te chame daqui umas semanas?"

Se cancelar sem remarcar, mover lead para nutrição (`conversation-state`).

### Lead some depois de marcar
Lembrete D-1: enviar manhã do dia anterior.
> "Oi [nome], lembrete da nossa conversa amanhã às [hora]. Tá de pé? 👍"

Lembrete D-0 (1h antes): apenas se for primeira reunião com o lead.
> "Oi! Daqui a 1h nossa call. Link: [URL]"

Se não responder o D-1 e não aparecer: chamar `flag_for_human` ou mover para follow-up de no-show.

### Lead quer marcar fora da janela útil (ex.: sábado, 21h)
Por padrão, recusar educadamente e oferecer alternativa:
> "A gente atende de segunda a sexta nos horários comerciais. Tenho [próxima opção viável], funciona?"
Exceção: se o cliente da agência tiver configurado horários alternativos, seguir a config.

### Conflito de fuso horário
Se lead mencionar cidade diferente ou explicitamente outro fuso, **sempre confirmar fuso** ao propor horário:
> "Quarta às 10h (horário de Brasília). No seu fuso fica [calcular]. Confirma?"

## Sinais de problema (parar e escalar via `handoff-criteria`)

- Lead pede para conversar **agora mesmo** e demonstra urgência alta (sinal de oportunidade — passar pra humano se possível).
- Lead pede reunião com **C-level específico** da BeeAds (sócio, diretor) — passar pra humano coordenar.
- Lead pede **NDA ou contratos** antes da reunião — passar pra humano.

## O que NUNCA fazer

- ❌ Mandar link de Calendly/Cal.com cru, sem qualificar.
- ❌ Perguntar "quando você prefere?" sem oferecer opções.
- ❌ Marcar reunião sem ter o email do lead.
- ❌ Criar evento sem confirmar com o lead os detalhes finais.
- ❌ Insistir em horário que o lead recusou ("mas terça às 14h ficava ótimo, não dá mesmo?").
- ❌ Marcar com lead que não passou na qualificação mínima (ver matriz em `sdr-qualification`).
