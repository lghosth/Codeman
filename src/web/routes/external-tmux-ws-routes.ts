/**
 * @fileoverview External-tmux terminal WebSocket route.
 *
 * Spawns `tmux attach-session -t <name>` via node-pty (argv form — the name is
 * never interpolated into a shell string, so it is injection-safe even before
 * the SAFE_EXTERNAL_NAME check). Output is micro-batched (shared ws-batch) and
 * DEC-2026-wrapped. The first frame sent is a {"t":"b"} scrollback snapshot so
 * the viewer restores history BEFORE live output flows — this avoids the
 * GET-buffer-then-open-WS race that would drop bytes emitted in between.
 *
 * Lifecycle: on WS close the attach PTY is killed, which DETACHES the Codeman
 * client from the tmux session — the user's session itself is unaffected. (If
 * the user's tmux sets `destroy-unattached`, the session may be destroyed; this
 * is the user's own config and is documented in the UI.)
 *
 * Auth: the global Host guard + optional CODEMAN_PASSWORD middleware cover this
 * route like every other; the upgrade additionally runs the Host/Origin check
 * (anti-CSWSH), identical to ws-routes.ts.
 *
 * Protocol (JSON text frames):
 *   Server -> Client: {"t":"b","d":"..."} initial scrollback snapshot (once)
 *                   {"t":"o","d":"..."} live output (batched, DEC-2026-wrapped)
 *                   {"t":"c"}           clear terminal
 *   Client -> Server: {"t":"i","d":"..."} input (keystroke/paste)
 *                     {"t":"z","c":N,"r":N} resize
 */
import { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import * as pty from 'node-pty';
import type { ExternalTmuxPort } from '../ports/external-tmux-port.js';
import { MAX_INPUT_LENGTH } from '../../config/terminal-limits.js';
import { isAllowedRequestHost, isAllowedRequestOrigin, type HostPolicy } from '../network-auth-policy.js';
import { createTerminalBatcher, type TerminalBatcher } from './ws-batch.js';
import { isValidExternalName } from '../../external-tmux-manager.js';

const WS_BATCH_INTERVAL_MS = 8;
const WS_BATCH_FLUSH_THRESHOLD = 16384;
const WS_PING_INTERVAL_MS = 30_000;
const WS_PONG_TIMEOUT_MS = 10_000;
const MAX_WS_PER_NAME = 3;

const nameWsCount = new Map<string, number>();

/** Clean env for the attach PTY: drop $TMUX so we hit the user's default server. */
function cleanAttachEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TMUX;
  env.LANG = env.LANG || 'en_US.UTF-8';
  env.TERM = 'xterm-256color';
  return env;
}

export function registerExternalTmuxWsRoutes(
  app: FastifyInstance,
  ctx: ExternalTmuxPort,
  getHostPolicy: () => HostPolicy
): void {
  app.get<{ Params: { name: string } }>(
    '/ws/external-tmux/:name/terminal',
    { websocket: true },
    (socket: WebSocket, req) => {
      if (!ctx.externalTmux.enabled) {
        socket.close(4003, 'External tmux disabled');
        return;
      }
      // Host/Origin guard (anti-CSWSH + DNS rebinding), same as ws-routes.ts:69-73.
      const policy = getHostPolicy();
      if (!isAllowedRequestHost(req.headers.host, policy) || !isAllowedRequestOrigin(req.headers.origin, policy)) {
        socket.close(4003, 'Forbidden');
        return;
      }

      const { name } = req.params;
      if (!isValidExternalName(name)) {
        socket.close(4004, 'Invalid session name');
        return;
      }
      if (!ctx.externalTmux.sessionExists(name)) {
        socket.close(4004, 'Session not found');
        return;
      }

      // Per-name connection limit.
      const count = nameWsCount.get(name) ?? 0;
      if (count >= MAX_WS_PER_NAME) {
        socket.close(4008, 'Too many connections');
        return;
      }
      nameWsCount.set(name, count + 1);

      socket.on('error', () => {});

      // Spawn the attach client via node-pty (argv form → injection-safe).
      let ptyProcess: pty.IPty;
      try {
        ptyProcess = pty.spawn('tmux', ['attach-session', '-t', name], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          env: cleanAttachEnv(),
        });
      } catch (err) {
        console.error('[ExternalTmuxWS] Failed to spawn attach PTY:', err);
        nameWsCount.set(name, (nameWsCount.get(name) ?? 1) - 1);
        socket.close(4010, 'Failed to attach');
        return;
      }

      const send = (frame: string) => {
        if (socket.readyState === 1) socket.send(frame);
      };

      // FIRST FRAME: scrollback snapshot (Codex correction #2). Captured at attach
      // time; any bytes the PTY emits after this flow as {"t":"o"} live frames.
      const snapshot = ctx.externalTmux.captureBuffer(name);
      if (snapshot) send(`{"t":"b","d":${JSON.stringify(snapshot)}}`);

      // Live output batcher.
      const batcher: TerminalBatcher = createTerminalBatcher({
        intervalMs: WS_BATCH_INTERVAL_MS,
        flushThreshold: WS_BATCH_FLUSH_THRESHOLD,
        onFlush: (wrapped) => send(`{"t":"o","d":${JSON.stringify(wrapped)}}`),
      });

      const onData = (data: string) => batcher.push(data);
      ptyProcess.onData(onData);

      const onExit = () => {
        batcher.flush();
        send('{"t":"c"}');
        socket.close(4010, 'tmux session exited');
      };
      ptyProcess.onExit(onExit);

      // Input + resize from client.
      socket.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.t === 'i' && typeof msg.d === 'string') {
            if (msg.d.length <= MAX_INPUT_LENGTH) ptyProcess.write(msg.d);
          } else if (
            msg.t === 'z' &&
            Number.isInteger(msg.c) &&
            Number.isInteger(msg.r) &&
            msg.c >= 1 &&
            msg.c <= 500 &&
            msg.r >= 1 &&
            msg.r <= 200
          ) {
            try {
              ptyProcess.resize(msg.c, msg.r);
            } catch {
              /* ignore */
            }
            // Fire-and-forget; argv form is injection-safe.
            ctx.externalTmux.resizeWindow(name, msg.c, msg.r);
          }
        } catch {
          /* ignore malformed */
        }
      });

      // Heartbeat (same as ws-routes.ts:206-221).
      let pongTimeout: ReturnType<typeof setTimeout> | null = null;
      socket.on('pong', () => {
        if (pongTimeout) {
          clearTimeout(pongTimeout);
          pongTimeout = null;
        }
      });
      const pingInterval = setInterval(() => {
        if (socket.readyState !== 1) return;
        socket.ping();
        pongTimeout = setTimeout(() => socket.terminate(), WS_PONG_TIMEOUT_MS);
      }, WS_PING_INTERVAL_MS);

      socket.on('close', () => {
        clearInterval(pingInterval);
        if (pongTimeout) clearTimeout(pongTimeout);
        batcher.dispose();
        // Kill the ATTACH client only → detaches from the user's tmux session.
        try {
          ptyProcess.kill();
        } catch {
          /* already gone */
        }
        const c = nameWsCount.get(name) ?? 1;
        if (c <= 1) nameWsCount.delete(name);
        else nameWsCount.set(name, c - 1);
      });
    }
  );
}
