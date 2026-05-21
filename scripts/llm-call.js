#!/usr/bin/env node
/**
 * llm-call.js — CLI fina sobre o llm-adapter.
 *
 * Lê um JSON request da stdin, devolve um JSON response na stdout.
 * Erros vão pra stderr; exit code != 0 em falha.
 *
 * Uso:
 *   node llm-call.js < request.json > response.json
 *
 * Formato do request: ver llm-adapter.js
 */

const { complete } = require('./llm-adapter');

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) {
    process.stderr.write('llm-call: stdin vazio\n');
    process.exit(2);
  }
  let req;
  try {
    req = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`llm-call: stdin JSON inválido — ${e.message}\n`);
    process.exit(2);
  }

  const resp = await complete(req);
  process.stdout.write(JSON.stringify(resp));
}

main().catch((err) => {
  process.stderr.write(`llm-call error: ${err.message}\n`);
  process.exit(1);
});
