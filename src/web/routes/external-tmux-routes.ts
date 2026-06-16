/**
 * @fileoverview External (default-socket) tmux session REST routes.
 * List + capture. The terminal stream itself is the WS route in
 * external-tmux-ws-routes.ts. All routes are no-ops (404/disabled) when the
 * feature gate is closed.
 */
import { FastifyInstance } from 'fastify';
import type { ExternalTmuxPort } from '../ports/external-tmux-port.js';
import { isValidExternalName } from '../../external-tmux-manager.js';

function disabledPayload() {
  return { enabled: false, sessions: [] as unknown[], reason: 'External tmux is not enabled on this instance.' };
}

export function registerExternalTmuxRoutes(app: FastifyInstance, ctx: ExternalTmuxPort): void {
  app.get('/api/external-tmux/sessions', async () => {
    if (!ctx.externalTmux.enabled) return disabledPayload();
    return { enabled: true, sessions: ctx.externalTmux.listSessions() };
  });

  app.get<{ Params: { name: string } }>('/api/external-tmux/sessions/:name/buffer', async (req, reply) => {
    if (!ctx.externalTmux.enabled) {
      reply.code(404);
      return { success: false, error: 'External tmux is not enabled.' };
    }
    const { name } = req.params;
    if (!isValidExternalName(name)) {
      reply.code(400);
      return { success: false, error: 'Invalid session name.' };
    }
    const buffer = ctx.externalTmux.captureBuffer(name);
    if (buffer === null) {
      reply.code(404);
      return { success: false, error: 'Session not found.' };
    }
    return { success: true, data: { buffer } };
  });
}
