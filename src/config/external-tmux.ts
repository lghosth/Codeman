/**
 * @fileoverview External-tmux feature gate. Attaching to an arbitrary tmux
 * session = host-user shell = RCE for whoever can reach the server, so the
 * feature is OFF by default. CODEMAN_EXTERNAL_TMUX=1 makes it available; a
 * non-loopback bind additionally requires CODEMAN_PASSWORD (or explicit ack),
 * mirroring the tunnel-enable rule.
 * @module config/external-tmux
 */
import { isLoopbackBindHost, isUnauthenticatedNetworkAcknowledged } from '../web/network-auth-policy.js';

export function isExternalTmuxRequested(): boolean {
  return process.env.CODEMAN_EXTERNAL_TMUX === '1';
}

export interface ExternalTmuxGate {
  enabled: boolean;
  reason?: string;
}

export function resolveExternalTmuxGate(bindHost: string, allowUnauthNetwork = false): ExternalTmuxGate {
  if (!isExternalTmuxRequested()) {
    return { enabled: false, reason: 'Set CODEMAN_EXTERNAL_TMUX=1 to enable attaching to external tmux sessions.' };
  }
  if (!isLoopbackBindHost(bindHost) && !isUnauthenticatedNetworkAcknowledged(allowUnauthNetwork)) {
    return {
      enabled: false,
      reason:
        'External tmux requested but bound to a non-loopback host without CODEMAN_PASSWORD. ' +
        'Set CODEMAN_PASSWORD, bind loopback + tunnel, or set CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1.',
    };
  }
  return { enabled: true };
}
