/**
 * @fileoverview Types for external (default-socket) tmux sessions.
 * @module types/external-tmux
 */

/** A tmux session on the user's default socket, discovered via `tmux list-sessions`. */
export interface ExternalTmuxSession {
  /** tmux session name (validated against SAFE_EXTERNAL_NAME). */
  name: string;
  /** Epoch seconds the session was created. */
  created: number;
  /** 1 if any client is attached, else 0. */
  attached: number;
  /** Number of windows in the session. */
  windows: number;
  /** Live window size (columns). */
  width: number;
  /** Live window size (rows). */
  height: number;
}
