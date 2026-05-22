# Skill: conversation-state

Temperatura do lead e cadência de follow-up. Estado lido em `<lead_state>`.

## Temperaturas

| Temperatura | Critério | Próxima ação |
|---|---|---|
| 🔥 Quente | Respondeu <24h E passou qualificação | Marcar reunião agora |
| ♨️ Morno | Respondeu nos últimos 7 dias, qualificação parcial | Continuar qualificando |
| ❄️ Frio | >7 dias sem resposta | Follow-up programado (D+2, D+7, D+21) |
| 🧊 Congelado | 3+ follow-ups sem resposta OU disse "não tenho interesse" | Arquivar (`archive_lead`) |

## Janela de silêncio normal

- <4h = lead ocupado, não é silêncio.
- 4-24h = neutro.
- 2-3 dias = primeiro follow-up D+2.
- >7 dias = lead esfriou.

## Follow-up proativo (não-runtime — o agente não inicia mas pode sugerir o copy)

- **D+2**: toque leve. "Oi [nome], passando para ver se você teve um tempo de pensar. Qualquer dúvida é só chamar 👍"
- **D+7**: reengajar com valor. "Oi [nome], lembrei de você. Saiu [conteúdo relevante]. Quer dar uma olhada?"
- **D+21**: última tentativa. "Oi [nome], última vez que te chamo aqui para não encher saco. Se voltar a fazer sentido, sabe onde me achar 👍"

## Arquivamento

Lead vai pra 🧊 (emitir action `archive_lead`):
- 3 follow-ups sem resposta.
- Lead disse "não tenho interesse" / "para de me mandar mensagem".
- 60+ dias sem qualquer interação.

## Lead voltou depois de sumido

Tratar como conversa nova com contexto. NÃO cobrar ("você sumiu!"):

> "Oi [nome], que bom ter notícias! Continua tocando [empresa]?"

## Conflito entre estado salvo e mensagem nova

Se o lead manda mensagem que contradiz o state (ex: state diz "tem verba", agora diz "não tenho"): acreditar na mensagem mais recente, atualizar estado, NÃO confrontar com inconsistência.

## NUNCA proativamente

- Manda bom dia / boa tarde diário.
- Manda conteúdo aleatório sem contexto.
- Manda 2 mensagens proativas em <48h.
- Envia depois das 21h ou antes das 9h.
- Envia domingo (sábado de manhã pode, moderado).
- Faz mais de 3 follow-ups sem resposta.
