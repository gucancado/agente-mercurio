# Eval harness — Mercurio SDR

Bateria de checks automáticos sobre as mensagens outbound do agente. Roda contra dados reais (`messages` no worker) sem custo LLM extra.

## Comandos

```bash
# 1) Eval offline (analisa messages já salvas) — rápido, $0
WORKER_TOKEN=... pnpm eval:offline

# 2) Salvar baseline (rodar uma vez, ou ao mudar config intencionalmente)
WORKER_TOKEN=... pnpm eval:baseline

# 3) Extrair fixtures pra replay futuro (sanitiza dados)
WORKER_TOKEN=... pnpm eval:extract
```

## O que mede

| Métrica | Como | Alvo |
|---|---|---|
| `anti_padroes_pct` | regex de palavras proibidas ("a gente", "rola", "tô", "pra", etc.) | < 5% |
| `saudacao_repetida_pct` | mensagem começa com "Oi/Olá/Bom dia" em outbound não-primeira-da-thread | < 10% |
| `disclosure_repetido_pct` | menção a "agente automatizada da BeeAds" fora da primeira da thread | < 5% |
| `muito_longo_pct` | mensagem com > 5 linhas | < 10% |
| `cost.avg_usd_per_response` | custo médio em USD | < $0.015 (com cache) |
| `latency_ms.p95` | latência p95 | < 5000ms |

## Distribuição de tiers esperada

- **baixo**: saudação, escolha horário, confirmação → ~30-40%
- **medio**: qualificação, pergunta serviço → ~50-60%
- **alto**: objeção, alta complexidade → < 15%

Se `alto` passa de 20% por dia, classifier está sendo conservador demais (estourando custo). Se `alto` é 0%, está sendo permissivo demais.

## Como usar pra validar mudança de config

1. Rodar baseline ANTES (`pnpm eval:baseline`).
2. Fazer a mudança (trocar modelo, ajustar skill, mudar threshold).
3. Coletar 20-30 conversas reais com a nova config.
4. Rodar `pnpm eval:offline`. O script imprime delta vs baseline.
5. Se anti_padroes_pct ou saudacao_repetida_pct subiu, **rollback**.

## Estrutura

```
tests/eval/
  check-quality.js          # módulo com checks (importável)
  run-offline-eval.js       # CLI principal
  extract-fixtures.js       # gera fixtures sanitizadas (replay futuro)
  baseline.json             # snapshot da config atual (v1)
  fixtures/                 # threads sanitizadas (gerado por extract)
  results/                  # output de cada run (auto-criado)
```

## Replay eval (futuro)

Pra mudanças mais arriscadas (trocar provedor de LLM, refactor de prompt), o eval offline é insuficiente — só vê o que está salvo, não testa "e se eu rodasse de novo?". Fica como **Fase 5b**: runner que pega fixtures, alimenta classifier+responder atual e compara com baseline. Não está implementado ainda; envolve gastar tokens reais.
