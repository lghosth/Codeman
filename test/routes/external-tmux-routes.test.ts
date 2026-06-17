/**
 * @fileoverview Tests for external-tmux REST and WebSocket routes.
 *
 * REST routes use app.inject(); WebSocket close-code assertions use a unique
 * local test port because inject() does not support upgrade requests.
 * Port: 3212 (external-tmux route WS tests)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';
import type { ExternalTmuxSession } from '../../src/types/external-tmux.js';
import type { ExternalTmuxPort } from '../../src/web/ports/external-tmux-port.js';
import { registerExternalTmuxRoutes } from '../../src/web/routes/external-tmux-routes.js';
import { registerExternalTmuxWsRoutes } from '../../src/web/routes/external-tmux-ws-routes.js';
import type { HostPolicy } from '../../src/web/network-auth-policy.js';

const PORT = 3212;

type MockExternalTmux = ExternalTmuxPort['externalTmux'];

function makeCtx(externalTmux: Partial<MockExternalTmux> & Pick<MockExternalTmux, 'enabled'>): ExternalTmuxPort {
  return {
    externalTmux: {
      enabled: externalTmux.enabled,
      listSessions: vi.fn(() => []),
      sessionExists: vi.fn(() => false),
      captureBuffer: vi.fn(() => null),
      ...externalTmux,
    } as MockExternalTmux,
  };
}

async function makeRestApp(ctx: ExternalTmuxPort): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerExternalTmuxRoutes(app, ctx);
  await app.ready();
  return app;
}

function waitForClose(ws: WebSocket, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      reject(new Error('WS close timeout'));
    }, timeoutMs);
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
    ws.on('error', () => {
      /* close frame follows */
    });
  });
}

let wsApp: FastifyInstance | null = null;

async function listenWs(ctx: ExternalTmuxPort, getHostPolicy: () => HostPolicy): Promise<void> {
  wsApp = Fastify({ logger: false });
  await wsApp.register(fastifyWebsocket);
  registerExternalTmuxWsRoutes(wsApp, ctx, getHostPolicy);
  await wsApp.listen({ port: PORT, host: '127.0.0.1' });
}

afterEach(async () => {
  if (wsApp) {
    await wsApp.close();
    wsApp = null;
  }
});

describe('external-tmux REST routes', () => {
  it('returns disabled payload when external tmux is disabled', async () => {
    const app = await makeRestApp(makeCtx({ enabled: false }));
    try {
      const res = await app.inject({ method: 'GET', url: '/api/external-tmux/sessions' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        enabled: false,
        sessions: [],
        reason: 'External tmux is not enabled on this instance.',
      });
    } finally {
      await app.close();
    }
  });

  it('returns sessions from an enabled external tmux manager', async () => {
    const sessions: ExternalTmuxSession[] = [
      { name: 'my-work_1', created: 123, attached: 1, windows: 2, width: 120, height: 40 },
    ];
    const listSessions = vi.fn(() => sessions);
    const app = await makeRestApp(makeCtx({ enabled: true, listSessions }));
    try {
      const res = await app.inject({ method: 'GET', url: '/api/external-tmux/sessions' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ enabled: true, sessions });
      expect(listSessions).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('rejects invalid buffer session names', async () => {
    const app = await makeRestApp(makeCtx({ enabled: true }));
    try {
      const res = await app.inject({ method: 'GET', url: '/api/external-tmux/sessions/bad.name/buffer' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ success: false, error: 'Invalid session name.' });
    } finally {
      await app.close();
    }
  });

  it('returns 404 when buffer capture misses', async () => {
    const captureBuffer = vi.fn(() => null);
    const app = await makeRestApp(makeCtx({ enabled: true, captureBuffer }));
    try {
      const res = await app.inject({ method: 'GET', url: '/api/external-tmux/sessions/missing/buffer' });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ success: false, error: 'Session not found.' });
      expect(captureBuffer).toHaveBeenCalledWith('missing');
    } finally {
      await app.close();
    }
  });
});

describe('external-tmux WebSocket route', () => {
  it('closes with 4003 when external tmux is disabled', async () => {
    await listenWs(makeCtx({ enabled: false }), () => ({ bindHost: '127.0.0.1', allowedHosts: [], tunnelHost: null }));
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/external-tmux/my-work_1/terminal`);

    const close = await waitForClose(ws);
    expect(close).toEqual({ code: 4003, reason: 'External tmux disabled' });
  });

  it('closes with 4003 on foreign Origin before session attach', async () => {
    const sessionExists = vi.fn(() => true);
    await listenWs(makeCtx({ enabled: true, sessionExists }), () => ({
      bindHost: '127.0.0.1',
      allowedHosts: [],
      tunnelHost: null,
    }));
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/external-tmux/my-work_1/terminal`, {
      headers: { origin: 'https://evil.attacker.example' },
    });

    const close = await waitForClose(ws);
    expect(close).toEqual({ code: 4003, reason: 'Forbidden' });
    expect(sessionExists).not.toHaveBeenCalled();
  });
});
