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
      const payload = await res.json();
      // API wraps responses as { success, data } — unwrap the data envelope.
      const data = payload && payload.data ? payload.data : payload;
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
      // Build via DOM API (no inline onclick — avoids attribute-quoting/XSS risks).
      body.innerHTML = '';
      for (const s of sessions) {
        const item = document.createElement('div');
        item.className = 'external-tmux-item';
        item.setAttribute('role', 'button');
        item.setAttribute('tabindex', '0');
        item.dataset.name = s.name;
        item.title = 'Attach to ' + s.name;

        const main = document.createElement('div');
        main.className = 'external-tmux-item-main';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'external-tmux-item-name';
        nameSpan.textContent = s.name; // textContent = auto-escaped
        main.appendChild(nameSpan);
        if (s.attached) {
          const badge = document.createElement('span');
          badge.className = 'external-tmux-badge attached';
          badge.textContent = 'attached';
          main.appendChild(badge);
        }
        item.appendChild(main);

        const meta = document.createElement('div');
        meta.className = 'external-tmux-item-meta';
        const winCount = document.createElement('span');
        winCount.textContent = s.windows + ' window' + (s.windows === 1 ? '' : 's');
        meta.appendChild(winCount);
        if (s.width && s.height) {
          const size = document.createElement('span');
          size.textContent = s.width + '×' + s.height;
          meta.appendChild(size);
        }
        const created = document.createElement('span');
        const d = new Date(s.created * 1000);
        created.textContent = isNaN(d.getTime()) ? '?' : d.toLocaleDateString();
        meta.appendChild(created);
        item.appendChild(meta);

        const open = () => this.openExternalTmuxViewer(s.name);
        item.addEventListener('click', open);
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        });
        body.appendChild(item);
      }
    } catch (err) {
      body.innerHTML = '<div class="external-tmux-empty">Failed to load sessions.</div>';
      console.error('[ExternalTmux] list failed:', err);
    }
  },
});
