import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import { SessionManager } from './SessionManager.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');

const PORT = parseInt(process.env.PORT || '8090', 10);
const HOST = process.env.HOST || '0.0.0.0';

const sessionManager = new SessionManager({
  apiKey: process.env.GEMINI_API_KEY
});

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml'
};

function serveStaticFile(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// Servidor HTTP unificado (API + Frontend estático + WebSockets)
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // 1. Health check
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      service: 'voicy-caption-stream',
      status: 'healthy',
      activeSessions: sessionManager.sessions.size,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // 2. Rutas amigables del Frontend
  if (pathname === '/' || pathname === '/index.html') {
    return serveStaticFile(path.join(FRONTEND_DIR, 'index.html'), res);
  }

  // audience.html fue removido — redirigir a index.html preservando el query string
  if (pathname === '/audience.html' || pathname === '/audience') {
    const qs = url.search || '';
    res.writeHead(301, { 'Location': `/${qs}` });
    res.end();
    return;
  }

  if (pathname === '/broadcast' || pathname.startsWith('/broadcast')) {
    return serveStaticFile(path.join(FRONTEND_DIR, 'broadcast.html'), res);
  }

  if (pathname === '/overlay' || pathname.startsWith('/overlay')) {
    return serveStaticFile(path.join(FRONTEND_DIR, 'overlay.html'), res);
  }

  if (pathname === '/monitor' || pathname.startsWith('/monitor')) {
    return serveStaticFile(path.join(FRONTEND_DIR, 'monitor.html'), res);
  }

  if (pathname === '/docs' || pathname.startsWith('/docs')) {
    return serveStaticFile(path.join(FRONTEND_DIR, 'docs.html'), res);
  }

  if (pathname.startsWith('/session') || pathname.startsWith('/audience') || pathname.startsWith('/stage-')) {
    return serveStaticFile(path.join(FRONTEND_DIR, 'index.html'), res);
  }

  // 3. Archivos estáticos directos (CSS, JS, Worklets)
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(FRONTEND_DIR, safePath);

  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isFile()) {
      serveStaticFile(filePath, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    }
  });
});

// Servidor WebSocket montado sobre el mismo servidor HTTP
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const match = url.pathname.match(/^\/ws\/broadcast\/([^/]+)$/);

  if (!match) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const sessionId = match[1];
  const speakerLang = url.searchParams.get('speakerLang') || url.searchParams.get('lang') || 'es';

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, sessionId, speakerLang);
  });
});

wss.on('connection', async (ws, request, sessionId, speakerLang = 'es') => {
  console.log(`[WebSocket] Nueva conexión de broadcaster para sesión: ${sessionId} (idioma orador: ${speakerLang})`);

  try {
    const session = await sessionManager.getOrCreateSession(sessionId, ws, { speakerLanguage: speakerLang });

    ws.send(JSON.stringify({
      type: 'connection_ack',
      sessionId: sessionId,
      message: 'Conectado al backend de Voicy. Listo para recibir audio.'
    }));

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        sessionManager.handleBroadcasterAudio(sessionId, data);
      } else {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.action === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', clientTime: msg.time, serverTime: Date.now() }));
          } else if (msg.action === 'configure') {
            if (msg.speakerLang) {
              console.log(`[WebSocket] Broadcaster configuró idioma de orador: ${msg.speakerLang}`);
              sessionManager.setSpeakerLanguage(sessionId, msg.speakerLang);
            }
          } else if (msg.action === 'stop') {
            console.log(`[WebSocket] Broadcaster solicitó detener sesión ${sessionId}`);
            sessionManager.terminateSession(sessionId);
          }
        } catch (e) {
          console.warn(`[WebSocket] Mensaje de texto no JSON recibido:`, data.toString());
        }
      }
    });

    ws.on('close', () => {
      console.log(`[WebSocket] Broadcaster cerró conexión para sesión: ${sessionId}`);
      sessionManager.handleBroadcasterDisconnect(sessionId);
    });

    ws.on('error', (err) => {
      console.error(`[WebSocket] Error en socket del broadcaster (${sessionId}):`, err.message);
    });
  } catch (err) {
    console.error(`[WebSocket] Error inicializando sesión ${sessionId}:`, err);
    ws.close(1011, 'Error inicializando sesión con Gemini');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Voicy All-in-One corriendo en http://${HOST}:${PORT}`);
  console.log(`🎙️ Studio Broadcaster: http://${HOST}:${PORT}/broadcast.html?session=main-stage`);
  console.log(`📱 Vista Audiencia:    http://${HOST}:${PORT}/audience.html?session=main-stage`);
  console.log(`📡 WebSocket endpoint: ws://${HOST}:${PORT}/ws/broadcast/:sessionId`);
  console.log(`=======================================================`);
});
