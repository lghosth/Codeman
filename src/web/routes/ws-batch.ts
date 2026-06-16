/**
 * @fileoverview Tiny per-connection output batcher for terminal WebSocket routes.
 * Groups rapid PTY redraws into single frames wrapped in DEC 2026 synchronized-
 * update markers so xterm.js renders atomically. Shared between the managed-
 * session WS (ws-routes.ts) and the external-tmux WS.
 * @module ws-batch
 */

/** DEC 2026 synchronized-update markers (see ws-routes.ts). */
export const DEC_2026_START = '\x1b[?2026h';
export const DEC_2026_END = '\x1b[?2026l';

export interface TerminalBatcherOptions {
  /** Max batch interval (ms). */
  intervalMs: number;
  /** Flush immediately above this size (bytes). */
  flushThreshold: number;
  /** Called with the DEC-2026-wrapped concatenated payload. */
  onFlush: (wrapped: string) => void;
}

export interface TerminalBatcher {
  /** Add a chunk of output. Auto-flushes on threshold; otherwise on the timer. */
  push(data: string): void;
  /** Flush any buffered data immediately. */
  flush(): void;
  /** Stop the timer and drop buffered data. */
  dispose(): void;
}

export function createTerminalBatcher(opts: TerminalBatcherOptions): TerminalBatcher {
  let chunks: string[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const doFlush = () => {
    timer = null;
    if (chunks.length === 0) {
      chunks = [];
      size = 0;
      return;
    }
    const data = chunks.join('');
    chunks = [];
    size = 0;
    opts.onFlush(DEC_2026_START + data + DEC_2026_END);
  };

  return {
    push(data: string) {
      chunks.push(data);
      size += data.length;
      if (size > opts.flushThreshold) {
        if (timer) clearTimeout(timer);
        doFlush();
        return;
      }
      if (!timer) timer = setTimeout(doFlush, opts.intervalMs);
    },
    flush() {
      if (timer) clearTimeout(timer);
      doFlush();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      chunks = [];
      size = 0;
    },
  };
}
