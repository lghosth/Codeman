/**
 * @fileoverview External tmux sessions panel — lists sessions on the user's
 * DEFAULT tmux socket (not Codeman's -L codeman managed sessions) and opens a
 * terminal viewer to attach. Polls GET /api/external-tmux/sessions while open.
 *
 * This is an opt-in feature gated server-side (CODEMAN_EXTERNAL_TMUX=1) and
 * client-side (App Settings → Display → "External tmux"). The feature is only
 * surfaced when window.__codemanExternalTmuxAvailable is true (set by the
 * server in renderIndexHtml).
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp class)
 * @dependency external-tmux-viewer.js (openExternalTmuxViewer — load order)
 * @loadorder 11.6 of 16 — loaded after panels-ui.js, before session-ui.js
 */

Object.assign(CodemanApp.prototype, {
  /**
   * Open the external-tmux sessions panel. Renders as a side sheet docked
   * under the header. Polls every 10s while open.
   */
  openExternalTmuxPanel() {
    if (!window.__codemanExternalTmuxAvailable) return;
    const panel = document.getElementById('externalTmuxPanel');
    if (!panel) return;
    panel.classList.add('open');
    this.refreshExternalTmuxList();
    // Start polling while open.
    this._externalTmuxPollTimer = setInterval(() => {
      if (panel.classList.contains('open')) {
        this.refreshExternalTmuxList();
      } else {
        this.stopExternalTmuxPoll();
      }
    }, 10000);
  },

  closeExternalTmuxPanel() {
    const panel = document.getElementById('externalTmuxPanel');
    if (panel) panel.classList.remove('open');
    this.stopExternalTmuxPoll();
  },

  toggleExternalTmuxPanel() {
    const panel = document.getElementById('externalTmuxPanel');
    if (!panel) return;
    if (panel.classList.contains('open')) {
      this.closeExternalTmuxPanel();
    } else {
      this.openExternalTmuxPanel();
    }
  },

  stopExternalTmuxPoll() {
    if (this._externalTmuxPollTimer) {
      clearInterval(this._externalTmuxPollTimer);
      this._externalTmuxPollTimer = null;
    }
  },

  async refreshExternalTmuxList() {
    const body = document.getElementById('externalTmuxSessionsBody');
    if (!body) return;
    body.innerHTML = '<div class="external-tmux-empty">Loading…</div>';
    try {
      const res = await fetch('/api/external-tmux/sessions');
      const data = await res.json();
      if (!data.enabled) {
        body.innerHTML = '<div class="external-tmux-empty">External tmux is not enabled on this instance.</div>';
        return;
      }
      const sessions = data.sessions || [];
      if (sessions.length === 0) {
        body.innerHTML =
          '<div class="external-tmux-empty">No tmux sessions found.<br>' +
          '<span class="external-tmux-hint">Create one with <code>tmux new -s &lt;name&gt;</code></span></div>';
        return;
      }
      body.innerHTML = sessions
        .map((s) => {
          const d = new Date(s.created * 1000);
          const createdStr = isNaN(d.getTime()) ? '?' : d.toLocaleDateString();
          const attachedBadge = s.attached ? '<span class="external-tmux-badge attached">attached</span>' : '';
          const sizeStr = s.width && s.height ? `${s.width}×${s.height}` : '';
          return (
            '<div class="external-tmux-item" onclick="app.openExternalTmuxViewer(' +
            JSON.stringify(s.name) +
            ')" role="button" tabindex="0">' +
            '<div class="external-tmux-item-main">' +
            '<span class="external-tmux-item-name">' +
            this._escapeHtml(s.name) +
            '</span>' +
            attachedBadge +
            '</div>' +
            '<div class="external-tmux-item-meta">' +
            '<span>' +
            s.windows +
            ' window' +
            (s.windows === 1 ? '' : 's') +
            '</span>' +
            (sizeStr ? '<span>' + sizeStr + '</span>' : '') +
            '<span>' +
            createdStr +
            '</span>' +
            '</div>' +
            '</div>'
          );
        })
        .join('');
    } catch (err) {
      body.innerHTML = '<div class="external-tmux-empty">Failed to load sessions.</div>';
      console.error('[ExternalTmux] list failed:', err);
    }
  },

  /**
   * Minimal HTML escaper for session names (names are already validated
   * server-side against /^[A-Za-z0-9_-]+$/, but defense-in-depth).
   */
  _escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => {
      switch (c) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        default:
          return '&#39;';
      }
    });
  },
});
