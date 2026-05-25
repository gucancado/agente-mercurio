---
name: processar-inbox
description: Lê mensagens não-processadas do worker (via platform:inbox_list_unread), identifica a persona pela instância, responde via whatsapp:send_message, marca lida via platform:inbox_mark_read. É o trabalho principal do tick em modo inbox-driven (v0.6).
---

# processar-inbox

Skill central do ciclo de operação do mercurio (e qualquer agente que use a inbox do worker).

## Quando usar

A cada tick `responsive` ou `daily`, esta skill processa o backlog de mensagens recebidas pelo worker desde o último tick. **Sempre é invocada no início do tick**, após `verificar-aprovacoes`.

## Algoritmo

1. **Lista inbox unread**:
   ```
   platform:inbox_list_unread(limit=20)
   ```
   Retorna array de items: `{ id, agent, channel, instance, identifier, push_name, message_text, workspace_id, evolution_event_id, created_at }`.

2. **Se vazio**: encerra com `[CONCLUÍDO TICK_<id>] inbox vazia`. Não invoca mais nada.

3. **Agrupa items por `instance`** (= projeto/persona):
   ```python
   from collections import defaultdict
   by_instance = defaultdict(list)
   for item in inbox:
       by_instance[item["instance"]].append(item)
   ```

4. **Para cada instance** (= persona), em ordem do array (FIFO):
   a. **Extrai slug do projeto** do final do nome da instância:
      ```
      slug = instance.split("-", 1)[1]   # "mercurio-metido-a-gente" -> "metido-a-gente"
      ```
   b. **cd projetos/<slug>/**, ou usa cd virtual se o tick não trocar de diretório.
   c. **Lê `projetos/<slug>/PROJECT.md`** pra carregar a persona (nome, voz, escopo).
   d. **Pra cada item da fila desse projeto**, em ordem:
      - Lê `projetos/<slug>/memoria/relacionamento/<identifier-sanitizado>.md` se existir, pra contexto.
      - Decide ação:
        - **Responder** (caso normal): compõe resposta conforme persona + tom.
        - **Escalonar** (mensagem ambígua/sensível): grava em `memoria/trabalhos-em-andamento/triagem-<id>.md`; envia placeholder educado pro cliente.
        - **Ignorar** (spam óbvio, número errado): marca lida sem responder.
      - Para qualquer ação que **envia** mensagem WhatsApp → invoca skill `aprovacao-humana` antes (classifica L0/L1/L2). Espera aprovação válida se L2.
      - Após envio bem-sucedido (ou decisão de ignorar):
        - `platform:inbox_mark_read(id, processed_by=TICK_ID)`
        - Atualiza `projetos/<slug>/memoria/relacionamento/<identifier>.md` com entrada nova.
        - Cria `projetos/<slug>/memoria/log-de-execucoes/<YYYY-MM-DD>-inbox_<id>.md`.

5. **Ao final**: comenta resumo na tarefa-mãe (se Bloquim sync estiver ativo) ou apenas registra em log local.

## Identificação da persona

A persona pública (nome, voz) **vem de `projetos/<slug>/PROJECT.md`**. Você NUNCA usa o nome técnico `mercurio` em mensagens externas. Sempre a persona definida no PROJECT.md do projeto ativo.

## Disclosure (primeira mensagem em thread)

Se `memoria/relacionamento/<identifier>.md` **não existe** (= contato novo), inclua disclosure na resposta usando a persona pública definida em PROJECT.md:

```
Oi! Aqui é da [persona pública do PROJECT.md].
[resposta à dúvida ou pergunta de qualificação]
```

Se já existe = thread continuada, dispensa disclosure.

## Constraints

- **Não envie mensagem sem `aprovacao-humana`**.
- **Não marque lido sem ter enviado** algo ou tomado decisão consciente (não pule items).
- **Não exceda 10 items por tick** em modo responsive (cap soft pra não acumular custo num tick só). Se a fila tem mais, processa os 10 mais antigos e os outros voltam no próximo tick.
- **Se acaba limite de turnos antes de processar tudo**, NÃO marca lidos os pendentes — próximo tick retoma.

## Implementação suggested

Skill é text-driven (você lê isto e age). Tools usadas:
- `platform:inbox_list_unread`
- `platform:inbox_mark_read`
- `whatsapp:send_message` (via aiteks-evolution-mcp configurado em `.mcp.json` do projeto)
- File system tools (Read, Write, Glob)
