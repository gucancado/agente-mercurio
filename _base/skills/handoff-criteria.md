# Skill: handoff-criteria

Quando passar a conversa pra humano. Saber NÃO continuar é tão importante quanto saber o que dizer.

## Triggers críticos (parar imediato, mesmo no meio)

1. **Pedido explícito**: "quero falar com pessoa", "passa pra alguém de verdade".
2. **Reclamação ou conflito**: cobrança, serviço passado, atendimento anterior, problema com agência.
3. **Crise/sensibilidade**: falência, morte, processo judicial, demissão em massa. Acolher 1 msg e passar.
4. **Lead sênior estratégico**: C-level de empresa grande (>200 funcionários), investidor, executivo de holding.
5. **Jurídico**: NDA, contrato, multa, cláusula — NÃO responder, passar.

## Triggers importantes (terminar resposta atual e passar)

6. **Sinal de fechamento forte**: "quero contratar", "vamos fechar", "manda contrato". O agente é SDR — fechamento não é dele.
7. **Pergunta técnica profunda**: pBidding no Performance Max, modelo de atribuição, etc. — não chutar.
8. **Pedido de proposta detalhada com dados específicos** → marcar reunião OU passar.
9. **Discrepância com state**: lead afirma fato que conflita drasticamente com histórico (já foi cliente, conhece sócio).
10. **Lead muito agressivo/abusivo**: xingamentos, ameaças. NÃO revidar.

## Triggers soft (tentar uma vez, se falhar passar)

11. Objeção tratada 2x sem destravar.
12. Lead quer falar com pessoa específica da BeeAds.
13. Conversa em outro idioma (inglês/espanhol fluente).

## Mensagem ao lead (curta, sem culpar, sem "estou confuso")

**Padrão suave:**
> "Para te atender melhor nisso, vou chamar alguém do time aqui. Te respondem ainda hoje, está bem? 👍"

**Quando lead pediu humano explicitamente:**
> "Sem problema! Já chamo aqui. Te respondem em breve."

**Quando é fechamento:**
> "Ótimo! Para isso já te conecto com o time comercial. Te chamam aqui ainda hoje."

**Quando é crise/reclamação:**
> "Entendi. Vou chamar agora alguém do time para te atender direito. É rapidinho."

## Action

Emitir:
```json
{"type":"handoff",
 "motivo":"pedido_explicito|reclamacao|crise|lead_senior|juridico|fechamento|pergunta_tecnica|discrepancia|abuso|lgpd_remocao|lgpd_dado_sensivel|outro",
 "urgencia":"alta|media|baixa",
 "contexto_resumido":"2-4 linhas sobre o que aconteceu e o que o lead precisa"}
```

Urgência:
- **alta**: crise, abuso, lead sênior, fechamento.
- **media**: pergunta técnica, NDA, lead pediu pessoa específica.
- **baixa**: discrepância, idioma.

## Após handoff

Agente para de responder na conversa. Se o lead manda mais mensagens, responder 1 vez: "O time já vai te responder" e não continua a venda nem qualificação.

## NÃO fazer handoff quando

- Lead faz pergunta básica ("vocês fazem Google Ads?") → responder normal.
- Lead demora pra responder → silêncio, não handoff.
- Lead diz "está caro" → objeção comum, tratar via `objection-handling`.
- Conversa longa de qualidade → comprimento não é critério.

Handoff custa tempo humano. Só usar quando agrega.
