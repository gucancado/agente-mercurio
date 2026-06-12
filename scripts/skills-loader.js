/**
 * skills-loader.js — carrega o subset de skills relevantes ao intent do
 * classifier.
 *
 * Princípio de cache: ordem alfabética RIGOROSA. A mesma combinação de skills
 * (sem importar a ordem que o intent "pediu") produz sempre o mesmo prompt
 * → mesma cache key no Anthropic → cache hit.
 *
 * Skills sempre presentes (transversais):
 *   - anti-padroes-tom  (repetição de conector / re-saudação / re-pergunta de info
 *                        já dada são os maiores delatores de bot — sempre carregar)
 *   - formato-saida
 *   - lgpd-ethics
 *   - whatsapp-tone
 *
 * Skills por intent (somadas às transversais):
 *   saudacao_inicial       → beeads-context
 *   qualificacao_resposta  → sdr-qualification
 *   pergunta_servico       → beeads-context, sdr-qualification
 *   escolha_horario        → meeting-scheduling
 *   confirmacao            → meeting-scheduling
 *   objecao                → objection-handling, sdr-qualification
 *   pedido_humano          → handoff-criteria
 *   outro                  → conversation-state, sdr-qualification
 *
 * extraSkills (2º arg): skills forçadas pelo orquestrador independente do intent.
 * Usado pra carregar `meeting-scheduling` quando o lead está mid-agendamento
 * (slot travado / coleta pendente) mesmo que o classifier devolva intent=outro.
 */

const fs = require('node:fs');
const path = require('node:path');

const SKILLS_DIR = path.join(process.env.WORKSPACE_DIR || '/workspace', '_base', 'skills');

const TRANSVERSAIS = ['anti-padroes-tom', 'formato-saida', 'lgpd-ethics', 'whatsapp-tone'];

const POR_INTENT = {
  saudacao_inicial:      ['beeads-context'],
  qualificacao_resposta: ['sdr-qualification'],
  pergunta_servico:      ['beeads-context', 'sdr-qualification'],
  escolha_horario:       ['meeting-scheduling'],
  confirmacao:           ['meeting-scheduling'],
  objecao:               ['objection-handling', 'sdr-qualification'],
  pedido_humano:         ['handoff-criteria'],
  outro:                 ['conversation-state', 'sdr-qualification'],
};

/**
 * @param {string} intent — valor de classifier.intent
 * @param {string[]} [extraSkills] — skills forçadas independente do intent
 * @returns {{ names: string[], text: string }}
 *   names: lista ordenada (pra logging/debug)
 *   text: conteúdo concatenado com separadores
 */
function loadSkillsForIntent(intent, extraSkills = []) {
  const skills = [...TRANSVERSAIS, ...(POR_INTENT[intent] || POR_INTENT.outro), ...extraSkills];
  // dedup + sort alfabético (cache key estável)
  const unique = [...new Set(skills)].sort();

  const parts = unique.map((name) => {
    const file = path.join(SKILLS_DIR, `${name}.md`);
    const content = fs.readFileSync(file, 'utf8');
    return content.trim();
  });

  return {
    names: unique,
    text: parts.join('\n\n---\n\n'),
  };
}

module.exports = { loadSkillsForIntent, TRANSVERSAIS, POR_INTENT };
