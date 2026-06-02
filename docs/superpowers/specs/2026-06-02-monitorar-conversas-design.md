# Tooling de análise e monitoramento de conversas — mercurio

**Data:** 2026-06-02
**Status:** implementado

## Problema

Analisar conversas do agente (recentes, específicas) e monitorar testes ao vivo é
atividade recorrente. Hoje exige, a cada vez: rederivar o token via Coolify, reler o
schema/endpoints do worker e renderizar tudo na mão. Lento e repetitivo.

## Objetivo

Ambiente pronto no repo `agente-mercurio` para que, quando o dono peça "analisa as
últimas conversas / a conversa do número X / monitora esse teste", o Claude entre direto
no modo — sem reler o worker nem puxar tudo manualmente.

## Decisões

- **Forma:** tooling Claude Code no próprio repo (sem GUI).
- **Cadência:** sob demanda (sem cron). `tail` cobre o "tempo real".
- **Limpeza de dados:** não apagar. Marcar contatos de teste num manifesto no repo
  (`test-contacts.json`) e filtrar na análise. Reversível, sem mexer no worker.

## Arquitetura

```
scripts/conversas/
  client.mjs           # acesso ao worker; lê secrets/.env.local; fetch nativo, zero deps
  render.mjs           # dados → markdown (labels neutros LEAD/AGENTE)
  cli.mjs              # subcomandos recent/thread/meetings/metrics/tail/mark-test
  test-contacts.json   # { numero: motivo } — contatos de teste
secrets/.env.local     # gitignored: WORKER_URL, WORKER_AGENT_TOKEN
.claude/skills/monitorar-conversas/SKILL.md
docs/superpowers/specs/2026-06-02-monitorar-conversas-design.md
```

**Fluxo:** CLI → `client.mjs` (GET /messages, /meetings, /metrics/summary com X-Agent-Token)
→ `render.mjs` (markdown) → stdout. O endpoint `/messages` não filtra por project/since;
filtro de tempo e exclusão de teste são client-side.

**Separação de responsabilidades:** os scripts só buscam e formatam (determinístico). O
julgamento — classificar anomalias, decidir se algo é bug sob a config atual — fica com o
modelo, guiado pela SKILL.md.

## A skill

- Gatilho via `description` (analisar/monitorar conversas).
- Manda **ler PROJECT.md + playbook atuais antes de julgar** tom/persona — evita
  falso-positivo contra transcrições de configs antigas (ex: persona "Mel" depreciada).
- Receita dos dois modos (análise sob demanda; `tail` ao vivo em background).
- **Checklist de anomalias** por severidade: confirmação fantasma, slot drift, data
  inválida (🔴); não-lê-estado, alucina contexto, disclosure (🟠); re-saudação, resposta
  duplicada, loop de coleta, slots remexendo (🟡); + casos que devem continuar funcionando.
- Schema de referência inline (não precisa abrir o worker).

## Boas práticas atendidas

- Secrets em env gitignored, fora do código e da skill.
- Skill focada, progressive disclosure, referencia a fonte-de-verdade em vez de duplicar.
- CLI fino e composável; módulos de responsabilidade única.
- Zero dependências novas (fetch nativo, Node ≥20).
- Marcação de teste reversível; nenhum dado destruído.

## Fora de escopo (YAGNI)

- Flag `is_test` no DB + endpoint (upgrade aditivo se virar painel gráfico).
- Cron/rotina agendada de relatório.
- GUI gráfica.
