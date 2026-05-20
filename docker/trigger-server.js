// HTTP trigger pro agente.
// Cada POST /trigger dispara `tick.sh responsive` em background.
// flock dentro do tick.sh garante que só 1 roda por vez (POSTs duplicados são absorvidos).
// Sem cron — agente fica idle até receber trigger do worker.

const http = require('http');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '3000', 10);
const SECRET = process.env.TRIGGER_SECRET || '';

function log(...args) {
  console.log(`[trigger ${new Date().toISOString()}]`, ...args);
}

function postDebug(text) {
  const url = process.env.WORKER_URL;
  const token = process.env.WORKER_TOKEN;
  if (!url || !token) return;
  const body = JSON.stringify({ source: 'trigger', text });
  const req = require('https').request(
    `${url}/debug`,
    {
      method: 'POST',
      headers: {
        'X-Agent-Token': token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 5000,
    },
    (res) => res.resume()
  );
  req.on('error', () => {});
  req.write(body);
  req.end();
}

function spawnTick() {
  const child = spawn('/workspace/scripts/tick.sh', ['responsive'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  return child.pid;
}

const server = http.createServer((req, res) => {
  // Endpoint /trigger: POST com auth, dispara tick em background
  if (req.method === 'POST' && req.url === '/trigger') {
    const headerSecret = req.headers['x-trigger-secret'];
    if (SECRET && headerSecret !== SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid trigger secret' }));
      return;
    }
    const pid = spawnTick();
    log(`triggered tick.sh pid=${pid}`);
    postDebug(`triggered pid=${pid}`);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted: true, pid }));
    return;
  }

  // Health
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ts: new Date().toISOString() }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  log(`listening on :${PORT}, trigger secret set: ${SECRET ? 'yes' : 'no'}`);
  postDebug(`trigger-server up on :${PORT}`);
});

// Graceful
['SIGTERM', 'SIGINT'].forEach((sig) => {
  process.on(sig, () => {
    log(`got ${sig}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
});
