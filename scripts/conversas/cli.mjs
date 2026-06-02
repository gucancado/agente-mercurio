#!/usr/bin/env node
/**
 * cli.mjs — CLI de análise/monitoramento de conversas do mercurio.
 *
 * Uso:
 *   node scripts/conversas/cli.mjs recent [--since 24h] [--include-tests]
 *   node scripts/conversas/cli.mjs thread <numero>
 *   node scripts/conversas/cli.mjs meetings [--status all|scheduled|cancelled|...]
 *   node scripts/conversas/cli.mjs metrics [--since 7d]
 *   node scripts/conversas/cli.mjs tail [--interval 90]   # segundos; loop ao vivo
 *   node scripts/conversas/cli.mjs mark-test <numero> "motivo"
 *
 * Números aceitam com ou sem "+". Saída é markdown — pensada pra eu (Claude) ler.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getMessages, getMeetings, getMetrics } from './client.mjs';
import { renderThreads, renderThread, renderMeetings, renderMetrics } from './render.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseFlags(args) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

function normNumber(n) {
  if (!n) return n;
  return n.startsWith('+') ? n : `+${n}`;
}

const [, , cmd, ...rest] = process.argv;
const { flags, pos } = parseFlags(rest);

try {
  switch (cmd) {
    case 'recent': {
      const msgs = await getMessages({ since: flags.since || '24h' });
      const { text } = renderThreads(msgs, { includeTests: !!flags['include-tests'] });
      console.log(text);
      break;
    }

    case 'thread': {
      const ident = normNumber(pos[0]);
      if (!ident) throw new Error('uso: thread <numero>');
      const msgs = await getMessages({ identifier: ident, since: flags.since || 'all' });
      console.log(renderThread(msgs, ident));
      break;
    }

    case 'meetings': {
      const meetings = await getMeetings({ status: flags.status || 'all' });
      console.log(renderMeetings(meetings));
      break;
    }

    case 'metrics': {
      const summary = await getMetrics({ since: flags.since || '7d' });
      console.log(renderMetrics(summary));
      break;
    }

    case 'tail': {
      const intervalMs = Number(flags.interval || 90) * 1000;
      const includeTests = !!flags['include-tests'];
      const testContacts = JSON.parse(
        readFileSync(resolve(__dirname, 'test-contacts.json'), 'utf-8')
      ).contacts || {};

      // baseline: maior id já visto agora (não relata histórico, só o que chega)
      let seen = new Set();
      const seed = await getMessages({ since: '6h' });
      for (const m of seed) seen.add(m.id);
      console.log(
        `# tail ativo (intervalo ${intervalMs / 1000}s). ${seen.size} msgs no baseline (6h). ` +
          `Aguardando novas... (Ctrl-C para sair)`
      );

      const poll = async () => {
        try {
          const msgs = await getMessages({ since: '6h' });
          const fresh = msgs.filter((m) => !seen.has(m.id));
          for (const m of fresh) {
            seen.add(m.id);
            if (m.identifier in testContacts && !includeTests) continue;
            const who = m.direction === 'inbound' ? 'LEAD  ' : 'AGENTE';
            const meta =
              m.direction === 'outbound' ? `  [${m.tier || '-'}/${m.classifier_intent || '-'}]` : '';
            const txt = String(m.text || '').replace(/\n/g, ' / ');
            console.log(`${m.created_at.slice(11, 19)} ${m.identifier} ${who}${meta}: ${txt}`);
          }
        } catch (e) {
          console.error(`[tail] erro no poll: ${e.message}`);
        }
      };
      setInterval(poll, intervalMs);
      // mantém processo vivo
      await new Promise(() => {});
      break;
    }

    case 'mark-test': {
      const ident = normNumber(pos[0]);
      const motivo = pos[1] || 'marcado manualmente';
      if (!ident) throw new Error('uso: mark-test <numero> "motivo"');
      const path = resolve(__dirname, 'test-contacts.json');
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      data.contacts = data.contacts || {};
      data.contacts[ident] = motivo;
      writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
      console.log(`Marcado ${ident} como teste: "${motivo}"`);
      break;
    }

    default:
      console.log(
        [
          'Comandos:',
          '  recent [--since 24h] [--include-tests]   threads recentes',
          '  thread <numero> [--since all]            uma conversa inteira',
          '  meetings [--status all]                  reuniões persistidas',
          '  metrics [--since 7d]                     resumo llm_metrics',
          '  tail [--interval 90] [--include-tests]   monitorar ao vivo',
          '  mark-test <numero> "motivo"              marcar contato como teste',
        ].join('\n')
      );
  }
} catch (e) {
  console.error(`ERRO: ${e.message}`);
  process.exit(1);
}
