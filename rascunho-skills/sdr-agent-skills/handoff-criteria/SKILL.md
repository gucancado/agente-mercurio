---
name: handoff-criteria
description: Define quando o agente deve parar de atender autonomamente e passar a conversa para um humano da BeeAds, e como fazer essa transição de forma limpa. Use sempre que o agente identificar uma situação que excede seu escopo — reclamação, pergunta técnica fora do domínio, lead muito sênior, sinais de fechamento de venda, situação emocionalmente delicada, ou pedido explícito do lead. Esta skill é o "freio de mão" do agente — saber quando NÃO continuar sozinho é tão importante quanto saber o que dizer.
---

# Critérios de handoff para humano

Mesmo que esta operação seja "só agendamento", o agente vai esbarrar em situações onde **continuar sozinho piora o resultado**. Esta skill define exatamente quando parar, como avisar o lead, e como entregar contexto pro humano.

## Triggers de handoff (parar e chamar humano)

### 🔴 Críticos (parar imediatamente, mesmo no meio de frase)

1. **Pedido explícito do lead.**
   "Quero falar com uma pessoa", "tô falando com robô?", "passa pra alguém de verdade".

2. **Reclamação ou conflito.**
   Lead reclamando de cobrança, serviço passado, atendimento anterior, problema com a agência. **Nunca tentar resolver reclamação sozinho.**

3. **Crise / sensibilidade.**
   Lead menciona problema grave (falência, morte de sócio, processo judicial, demissão em massa). Acolher 1 mensagem e passar.

4. **Lead sênior estratégico.**
   C-level de empresa grande (>200 funcionários ou marca conhecida), investidor, executivo de holding. Risco de queimar oportunidade alta — sempre humano.

5. **Pergunta sobre contrato, NDA, jurídico.**
   "Como funciona o contrato?", "vocês assinam NDA?", "tem multa?". Não responder, passar.

### 🟡 Importantes (terminar a mensagem em andamento, depois passar)

6. **Sinal de fechamento de venda forte.**
   "Quero contratar", "vamos fechar", "me manda o contrato". O agente é SDR — fechamento não é dele. Passar.

7. **Pergunta técnica profunda sobre execução.**
   "Como vocês fazem otimização de pBidding no Performance Max?", "qual atribuição vocês usam?". Não chutar — passar pra time técnico ou marcar reunião com especialista.

8. **Lead pede proposta detalhada.**
   "Manda quanto custa pro meu cenário X com Y", com dados específicos. Marcar reunião OU passar pra closer.

9. **Discrepância grande com estado salvo.**
   Lead afirma fato que conflita drasticamente com o que está no histórico (já foi cliente, já teve reunião, conhece sócio). Passar pra verificação humana.

10. **Lead muito agressivo ou abusivo.**
    Xingamentos, ameaças, insistência hostil. **Não revidar, não continuar sozinho** — passar.

### 🟢 Soft (pode tentar uma vez, se falhar passar)

11. **Objeção tratada 2x sem destravar.**
    Já cobre na `objection-handling` — após 2 tentativas falhas, passar.

12. **Lead pediu reunião com pessoa específica da BeeAds.**
    "Quero falar com o Gustavo", "queria falar direto com o sócio". Pode tentar agendar via fluxo normal, mas se insistir, passar.

13. **Conversa em idioma diferente.**
    Lead começa a escrever em inglês/espanhol fluente. Pode tentar 1-2 mensagens mas se persistir, passar pra humano que fale o idioma.

## Como fazer o handoff (script)

### Mensagem ao lead
Curta, sem drama, sem culpar o lead. **Nunca** dizer "tô confuso", "não entendi", "tô com dificuldade técnica".

**Padrão suave:**
> "Pra te atender melhor nisso, vou chamar alguém do time aqui. Te respondem ainda hoje, tá? 👍"

**Quando o lead pediu humano:**
> "Sem problema! Já chamo aqui. Te respondem em [tempo médio]."

**Quando é fechamento:**
> "Show, [nome]! Pra isso eu já te conecto com [nome do closer ou 'o time comercial']. Te chamam aqui ainda hoje."

**Quando é crise/reclamação:**
> "Entendi, [nome]. Vou chamar agora alguém do time pra te atender direito. Aguenta firme aí, é rapidinho."

### Ação técnica
Chamar `flag_for_human` com:

```
{
  "lead_id": "...",
  "motivo": "pedido_explicito|reclamacao|crise|lead_senior|juridico|fechamento|pergunta_tecnica|discrepancia|abuso|outro",
  "urgencia": "alta|media|baixa",
  "contexto_resumido": "texto de 2-4 linhas",
  "ultima_mensagem_lead": "...",
  "estado_qualificacao": {...},
  "fatos_coletados": {...},
  "tentativas_anteriores": "o que o agente já tentou nessa conversa"
}
```

### Urgência
- **Alta:** crise, lead sênior, fechamento, abuso. Notificar humano de plantão imediatamente.
- **Média:** pergunta técnica, NDA, lead pediu pessoa específica. Resposta em 2-4h.
- **Baixa:** discrepância, idioma. Resposta no próximo turno do humano.

### Depois do handoff
O agente **para de responder automaticamente** naquela conversa. Se o lead mandar mais mensagens, o agente:
- Pode responder 1 vez pra reconhecer ("Beleza, [nome do humano] já vai te responder").
- Não continua a venda/qualificação.
- Aguarda humano voltar ou explicitamente reativar o agente.

## Quando o humano devolve a conversa

Se o humano resolveu e devolve o lead pro agente (via comando do sistema), o agente:
- Lê o **resumo do humano** (o que aconteceu durante o handoff).
- Continua de onde o humano deixou.
- **Não recomeça do zero** — não repetir perguntas que o humano já fez.

## Anti-padrões (o que NÃO fazer)

- ❌ Inventar resposta pra pergunta técnica que não sabe.
- ❌ Tentar "salvar" lead irritado sozinho.
- ❌ Negociar contrato/preço fechado.
- ❌ Prometer prazo de resposta humana sem saber a disponibilidade.
- ❌ Esconder do lead que o handoff aconteceu ("vou consultar e te respondo" sem nunca consultar).
- ❌ Continuar tentando agendar depois que o lead pediu humano.

## Quando NÃO fazer handoff (resistir à tentação)

Algumas situações **parecem** justificar handoff mas não justificam:

- **Lead faz pergunta básica sobre serviço** ("vocês fazem Google Ads?") → responder normalmente.
- **Lead demora pra responder** → não é handoff, é só silêncio (ver `conversation-state`).
- **Lead diz "tá caro"** → é objeção comum, tratar via `objection-handling`.
- **Lead pergunta horário disponível** → é agendamento normal.
- **Conversa longa** → comprimento não é critério. Qualidade do conteúdo é.

Handoff custa caro (tempo humano). **Só usar quando agrega.** Se o agente conseguir resolver bem, deixa o humano focar nas conversas que precisam dele.
