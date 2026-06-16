/**
 * @fileoverview Port for external-tmux routes.
 */
import type { ExternalTmuxManager } from '../../external-tmux-manager.js';

export interface ExternalTmuxPort {
  readonly externalTmux: ExternalTmuxManager;
}
