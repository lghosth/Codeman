/**
 * @fileoverview External (default-socket) tmux session discovery + buffer capture.
 *
 * Independent of TmuxManager (which owns the `-L codeman` managed sessions).
 * Every tmux invocation uses argv form (no shell string) and a clean env with
 * TMUX deleted, so the manager targets the user's DEFAULT tmux server even when
 * the Codeman process itself was launched from inside a tmux session.
 *
 * Test mode: under vitest (VITEST env), all shell commands are disabled and the
 * manager returns empty results — it physically cannot touch real tmux.
 *
 * @module external-tmux-manager
 */
import { execFileSync } from 'node:child_process';
import { EXEC_TIMEOUT_MS } from './config/exec-timeout.js';
import type { ExternalTmuxSession } from './types/external-tmux.js';

const IS_TEST_MODE = !!process.env.VITEST;

/** Max length of an external session name we will accept. */
export const MAX_EXTERNAL_NAME_LENGTH = 64;

/**
 * Safe-name pattern for external tmux sessions. tmux itself forbids `.` and `:`
 * in session names; we additionally restrict to a conservative charset to keep
 * names safe for interpolation in logs/UI. Any name entering a tmux argv must
 * pass this first.
 */
export const SAFE_EXTERNAL_NAME = /^[A-Za-z0-9_-]+$/;

/** Lines of scrollback to capture with `-S -N` (bounded to avoid huge payloads). */
const CAPTURE_SCROLLBACK_LINES = 2000;

export function isValidExternalName(name: string): boolean {
  return SAFE_EXTERNAL_NAME.test(name) && name.length > 0 && name.length <= MAX_EXTERNAL_NAME_LENGTH;
}

/**
 * Build a clean environment for tmux calls on the user's default socket. Deletes
 * $TMUX so a Codeman server launched inside tmux doesn't resolve bare `tmux` to
 * the nested server. (Codeman's own TmuxManager deletes TMUX at create time —
 * src/tmux-manager.ts ~line 1040 — for the same reason.)
 */
function cleanTmuxEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TMUX;
  return env;
}

export interface ExternalTmuxManagerOptions {
  /** When false, all routes report disabled and do nothing. Set from resolveExternalTmuxGate(). */
  enabled: boolean;
}

export class ExternalTmuxManager {
  readonly enabled: boolean;

  constructor(opts: ExternalTmuxManagerOptions) {
    this.enabled = opts.enabled;
  }

  /** List sessions on the default socket (no -L). Returns [] when disabled/test. */
  listSessions(): ExternalTmuxSession[] {
    if (!this.enabled || IS_TEST_MODE) return [];
    // argv form — name/session formats are tmux-controlled, but we parse defensively.
    const format =
      '#{session_name}|#{session_created}|#{session_attached}|#{session_windows}|#{session_width}|#{session_height}';
    let output = '';
    try {
      output = execFileSync('tmux', ['list-sessions', '-F', format], {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
        env: cleanTmuxEnv(),
      });
    } catch {
      // No tmux server running / tmux missing → no sessions.
      return [];
    }
    const sessions: ExternalTmuxSession[] = [];
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [name, created, attached, windows, width, height] = trimmed.split('|');
      if (!name || !isValidExternalName(name)) continue; // skip unsafe/foreign-named sessions
      sessions.push({
        name,
        created: Number(created) || 0,
        attached: Number(attached) || 0,
        windows: Number(windows) || 0,
        width: Number(width) || 0,
        height: Number(height) || 0,
      });
    }
    return sessions;
  }

  /** True if a session with this name exists on the default socket. */
  sessionExists(name: string): boolean {
    if (!this.enabled || IS_TEST_MODE || !isValidExternalName(name)) return false;
    try {
      execFileSync('tmux', ['has-session', '-t', name], {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
        env: cleanTmuxEnv(),
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Capture the session's active pane including bounded scrollback, with ANSI
   * escapes preserved. Used by the WS route as the first frame so the viewer
   * restores scrollback before live output flows (avoids the GET-then-WS race).
   * Returns null if the session is gone.
   */
  captureBuffer(name: string): string | null {
    if (!this.enabled || IS_TEST_MODE || !isValidExternalName(name)) return null;
    try {
      // -S -N: include N lines of scrollback above the viewport; -e: keep escapes.
      const buf = execFileSync('tmux', ['capture-pane', '-p', '-e', '-S', `-${CAPTURE_SCROLLBACK_LINES}`, '-t', name], {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
        env: cleanTmuxEnv(),
      });
      return buf;
    } catch {
      return null;
    }
  }
}
