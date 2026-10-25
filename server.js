#!/usr/bin/env node

import fs from 'fs';
import http from 'http';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import pty from '@lydell/node-pty';
import { WebSocketServer } from 'ws';

import {
  createAuthConfig,
  isLoopbackHost,
  isWildcardBindHost,
  validateTokenRequest,
  validateWebSocketRequest,
} from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HTTP_PORT = parsePort(process.env.PORT || '8080');
const AUTH_CONFIG = createAuthConfig();
const HOST = AUTH_CONFIG.bindHost;

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535: ${value}`);
  }
  return port;
}

// ============================================================================
// Locate ghostty-web assets
// ============================================================================

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

function findGhosttyWeb() {
  const localDist = path.join(__dirname, 'node_modules', 'ghostty-web', 'dist');
  const localWasm = path.join(__dirname, 'node_modules', 'ghostty-web', 'ghostty-vt.wasm');
  if (fs.existsSync(path.join(localDist, 'ghostty-web.js')) && fs.existsSync(localWasm)) {
    return { distPath: localDist, wasmPath: localWasm };
  }

  try {
    const ghosttyWebMain = require.resolve('ghostty-web');
    const ghosttyWebRoot = ghosttyWebMain.replace(/[/\\]dist[/\\].*$/, '');
    const distPath = path.join(ghosttyWebRoot, 'dist');
    const wasmPath = path.join(ghosttyWebRoot, 'ghostty-vt.wasm');

    if (fs.existsSync(path.join(distPath, 'ghostty-web.js')) && fs.existsSync(wasmPath)) {
      return { distPath, wasmPath };
    }
  } catch (e) {
    // require.resolve failed, package not found
  }

  console.error('Error: Could not find ghostty-web package.');
  console.error('Run: npm install');
  process.exit(1);
}

const { distPath, wasmPath } = findGhosttyWeb();

// ============================================================================
// Shell / tmux startup
// ============================================================================

function getShell() {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

function tmuxAvailable() {
  if (process.platform === 'win32') return false;
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function tmuxHasSession() {
  if (!tmuxAvailable()) return false;
  try {
    execFileSync('tmux', ['has-session'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getStartupCommand() {
  const startupFile = path.join(__dirname, 'startup.sh');
  if (fs.existsSync(startupFile)) {
    const command = fs.readFileSync(startupFile, 'utf8').trim();
    if (command.length > 0) {
      return process.platform === 'win32'
        ? { file: getShell(), args: ['/c', command] }
        : { file: getShell(), args: ['-c', command] };
    }
  }

  if (process.platform === 'win32' || !tmuxAvailable()) {
    return { file: getShell(), args: [] };
  }

  return tmuxHasSession()
    ? { file: 'tmux', args: ['attach'] }
    : { file: 'tmux', args: [] };
}

function createPtySession(cols, rows) {
  const startup = getStartupCommand();

  const ptyProcess = pty.spawn(startup.file, startup.args, {
    name: 'xterm-256color',
    cols: cols,
    rows: rows,
    cwd: homedir(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  });

  return ptyProcess;
}

// ============================================================================
// HTTP Server
// ============================================================================

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  const url = parseRequestUrl(req);
  if (!url) {
    writeHttpDecision(res, { status: 400, reason: 'Bad Request' });
    return;
  }

  if (handleTokenRequest(req, res, url)) {
    return;
  }

  const pathname = url.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    fs.readFile(htmlPath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('index.html not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  if (pathname.startsWith('/dist/')) {
    const filePath = path.join(distPath, pathname.slice(6));
    serveFile(filePath, res);
    return;
  }

  if (pathname === '/ghostty-vt.wasm') {
    serveFile(wasmPath, res);
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

function serveFile(filePath, res) {
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function parseRequestUrl(req) {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1');
  } catch (_error) {
    return null;
  }
}

function writeHttpDecision(res, decision) {
  res.writeHead(decision.status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(decision.reason);
}

function writeTokenResponse(res) {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify({ token: AUTH_CONFIG.token }));
}

function handleTokenRequest(req, res, url) {
  if (url.pathname !== '/api/token') {
    return false;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, {
      Allow: 'GET',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end('Method Not Allowed');
    return true;
  }

  const decision = validateTokenRequest(AUTH_CONFIG, {
    host: req.headers.host,
    origin: req.headers.origin,
  });

  if (!decision.ok) {
    writeHttpDecision(res, decision);
    return true;
  }

  writeTokenResponse(res);
  return true;
}

// ============================================================================
// WebSocket Server
// ============================================================================

const sessions = new Map();

const wss = new WebSocketServer({ noServer: true });

function rejectUpgrade(socket, decision) {
  if (socket.destroyed) return;
  const body = decision.reason + '\n';
  socket.write(
    `HTTP/1.1 ${decision.status} ${decision.reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'X-Content-Type-Options: nosniff\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body
  );
  socket.destroy();
}

function handleWebSocketUpgrade(req, socket, head) {
  const url = parseRequestUrl(req);
  if (!url) {
    rejectUpgrade(socket, { status: 400, reason: 'Bad Request' });
    return true;
  }

  if (url.pathname !== '/ws') {
    return false;
  }

  const decision = validateWebSocketRequest(AUTH_CONFIG, {
    host: req.headers.host,
    origin: req.headers.origin,
    token: url.searchParams.get('token'),
  });

  if (!decision.ok) {
    rejectUpgrade(socket, decision);
    return true;
  }

  if (!socket.destroyed && !socket.readableEnded) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }
  return true;
}

httpServer.on('upgrade', (req, socket, head) => {
  if (!handleWebSocketUpgrade(req, socket, head)) {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  const url = parseRequestUrl(req);
  if (!url) {
    ws.close();
    return;
  }
  const cols = Number.parseInt(url.searchParams.get('cols') || '80');
  const rows = Number.parseInt(url.searchParams.get('rows') || '24');

  const ptyProcess = createPtySession(cols, rows);
  sessions.set(ws, { pty: ptyProcess });

  ptyProcess.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[33mShell exited (code: ${exitCode})\x1b[0m\r\n`);
      ws.close();
    }
  });

  ws.on('message', (data) => {
    const message = data.toString('utf8');

    if (message.startsWith('{')) {
      try {
        const msg = JSON.parse(message);
        if (msg.type === 'resize') {
          ptyProcess.resize(msg.cols, msg.rows);
          return;
        }
      } catch (e) {
        // Not JSON, treat as input
      }
    }

    ptyProcess.write(message);
  });

  ws.on('close', () => {
    const session = sessions.get(ws);
    if (session) {
      session.pty.kill();
      sessions.delete(ws);
    }
  });

  ws.on('error', () => {
    // Ignore socket errors
  });
});

// ============================================================================
// Startup
// ============================================================================

function formatUrlHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

const startup = getStartupCommand();
console.log(`Starting with: ${startup.file} ${startup.args.join(' ')}`.trim());

httpServer.listen(HTTP_PORT, HOST, () => {
  console.log('\n' + '='.repeat(60));
  console.log('  ghostty-web fullscreen');
  console.log('='.repeat(60));
  console.log(`\n  Open: http://${formatUrlHost(HOST)}:${HTTP_PORT}`);
  console.log(`  Shell command: ${startup.file} ${startup.args.join(' ')}`.trim());
  console.log('  Bind host: ' + HOST);
  console.log('\n  Press Ctrl+C to stop.\n');
  console.log('='.repeat(60));
});

process.on('SIGINT', () => {
  console.log('\n\nShutting down...');
  for (const [ws, session] of sessions.entries()) {
    session.pty.kill();
    ws.close();
  }
  wss.close();
  process.exit(0);
});
