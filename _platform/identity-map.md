# Identidade do agente mercurio

## Identidade técnica (1:1)

| Recurso | Valor |
|---|---|
| Nome técnico | `mercurio` |
| Função | Agente atendente WhatsApp multi-persona |
| Repo Git | `gucancado/agente-mercurio` (público) |
| Container Coolify | `agente-mercurio` no projeto `semente-platform` |
| Conta Anthropic | workspace existente do owner (API key em env `ANTHROPIC_API_KEY`) |
| GitHub PAT | não usa (repo público) |
| Worker token | env var `MERCURIO_WORKER_TOKEN` (32 bytes hex aleatório) |
| User Bloquim | a definir (sync com Bloquim é opcional v0.6+) |
| Owner | Gustavo Cançado de Azevedo |
| Provisionado em | 2026-05-20 |

## Cadência

Perfis ativos: `responsive` (5min comercial / 30min fora; processa inbox a cada tick). Configuração em `scripts/cadencia.yml`.

## Personas (1 por projeto)

### Projeto `metido-a-gente`

| Campo | Valor |
|---|---|
| Persona pública | **Mel** |
| Instância Evolution | `mercurio-metido-a-gente` |
| Instance UUID | `3fb4de6a-57bf-469d-9af4-5600c556b1bf` |
| Instance hash | `03512C7D-F379-460C-BADD-F0D387574E72` |
| Número WhatsApp | +55 31 9778-6735 (temporário) |
| Conta Google | n/a (sem email/Drive nessa persona) |
| Workspace Bloquim | n/a (Bloquim sync desligado no MVP) |
| Provisionada em | 2026-05-20 |

Briefing completo em `projetos/metido-a-gente/PROJECT.md`.

## Governança

- Política de aprovação: `_base/policies/approval.yml`
- Approvers: `_platform/approvers.yml`
- Workspaces no FS: `_platform/workspace-map.json`

## Histórico

- 2026-05-20: agente provisionado. Persona Mel ativada no projeto metido-a-gente.
