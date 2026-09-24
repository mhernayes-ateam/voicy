import http from 'http';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import { SessionManager } from './SessionManager.js';

dotenv.config();

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

const sessionManager = new SessionManager({
  apiKey: process.env.GEMINI_API_KEY
});

// Servidor HTTP básico
const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      service: 'voicy-caption-stream',
      status: 'healthy',
      activeSessions: sessionManager.sessions.size,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Servidor WebSocket montado sobre el servidor HTTP
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

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, sessionId);
  });
});

wss.on('connection', async (ws, request, sessionId) => {
  console.log(`[WebSocket] Nueva conexión de broadcaster para sesión: ${sessionId}`);

  try {
    const session = await sessionManager.getOrCreateSession(sessionId, ws);

    ws.send(JSON.stringify({
      type: 'connection_ack',
      sessionId: sessionId,
      message: 'Conectado al backend de Voicy. Listo para recibir audio.'
    }));

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // Audio PCM Int16 raw enviado por el AudioWorklet
        sessionManager.handleBroadcasterAudio(sessionId, data);
      } else {
        // Mensajes de control / comandos JSON
        try {
          const msg = JSON.parse(data.toString());
          if (msg.action === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', clientTime: msg.time, serverTime: Date.now() }));
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
  console.log(`🚀 Voicy Caption Stream escuchando en http://${HOST}:${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://${HOST}:${PORT}/ws/broadcast/:sessionId`);
  console.log(`🏥 Health check: http://${HOST}:${PORT}/health`);
  console.log(`=======================================================`);
});
