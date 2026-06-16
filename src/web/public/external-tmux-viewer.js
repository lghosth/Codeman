/**
 * @fileoverview External tmux terminal viewer — a fullscreen overlay that
 * attaches to a tmux session on the user's DEFAULT socket via the
 * /ws/external-tmux/:name/terminal WebSocket.
 *
 * SELF-CONTAINED by design (Codex review correction #6): does NOT reuse
 * mobile-handlers.js KeyboardHandler or input-cjk.js, both of which are
 * hardcoded to #terminalContainer / app.terminal / app.fitAddon / the main
 * session's resize endpoint. Instead it uses xterm.js's own internal textarea
 * (handles soft keyboards + basic IME) and a dedicated visualViewport
 * listener for resize. A custom accessory bar / dedicated CJK overlay is
 * deferred to a v2.
 *
 * Protocol (matches external-tmux-ws-routes.ts):
 *   Server → Client: {"t":"b","d":"..."} initial scrollback snapshot (once)
 *                   {"t":"o","d":"..."} live output (DEC-2026-wrapped)
 *                   {"t":"c"}           clear terminal
 *   Client → Server: {"t":"i","d":"..."} input (keystroke/paste)
 *                     {"t":"z","c":N,"r":N} resize
 *
 * Reconnect: exponential backoff (250ms→2s, capped, 5 attempts). On reconnect
 * the server sends a fresh {"t":"b"} snapshot which resets + restores
 * scrollback.
 *
 * Lifecycle: closing the viewer disposes the terminal + closes the WS, which
 * kills the attach PTY server-side = DETACH ONLY (the user's tmux session
 * survives). See external-tmux-ws-routes.ts close handler.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency vendor/xterm.min.js (Terminal)
 * @dependency vendor/xterm-addon-fit.min.js (FitAddon)
 * @dependency terminal-ui.js (window.codemanCurrentXtermTheme — global theme helper)
 * @dependency mobile-handlers.js (MobileDetection — device type only, NOT KeyboardHandler)
 * @loadorder 11.7 of 16 — loaded after external-tmux-panel.js, before session-ui.js
 */

Object.assign(CodemanApp.prototype, {
  /**
   * Open a fullscreen terminal viewer attached to the named external tmux
   * session. Only one viewer at a time — calling again replaces the current.
   */
  openExternalTmuxViewer(name) {
    if (!window.__codemanExternalTmuxAvailable) return;
    // Close any existing viewer first.
    this.closeExternalTmuxViewer();

    const overlay = document.getElementById('externalTmuxViewer');
    if (!overlay) {
      console.error('[ExternalTmux] viewer container not found');
      return;
    }

    const isMobile = typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType() === 'mobile';

    // --- xterm setup (reuses global theme helper from terminal-ui.js) ---
    const TerminalCtor = window.Terminal;
    const FitAddonCtor = window.FitAddon && window.FitAddon.FitAddon;
    if (!TerminalCtor || !FitAddonCtor) {
      console.error('[ExternalTmux] xterm or FitAddon not loaded');
      return;
    }
    const theme = typeof window.codemanCurrentXtermTheme === 'function' ? window.codemanCurrentXtermTheme() : undefined;
    const terminal = new TerminalCtor({
      theme: theme ? { ...theme } : undefined,
      fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", Monaco, monospace',
      fontSize: isMobile ? 10 : 14,
      lineHeight: 1.2,
      cursorBlink: false,
      cursorStyle: 'block',
      scrollback: 5000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddonCtor();
    terminal.loadAddon(fitAddon);

    const termEl = document.getElementById('externalTmuxViewerTerminal');
    if (!termEl) {
      console.error('[ExternalTmux] terminal element not found');
      return;
    }
    termEl.innerHTML = '';
    terminal.open(termEl);

    // Update the viewer title with the session name.
    const titleEl = document.getElementById('externalTmuxViewerTitle');
    if (titleEl) titleEl.textContent = name;

    overlay.classList.add('open');

    // Fit after the overlay is visible (dimensions are real now).
    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        /* dimensions not ready yet — resize handler will catch up */
      }
    });

    // --- WebSocket connect ---
    const wsUrl =
      (location.protocol === 'https:' ? 'wss:' : 'ws:') +
      '//' +
      location.host +
      '/ws/external-tmux/' +
      encodeURIComponent(name) +
      '/terminal';

    let ws = null;
    let receivedFirstFrame = false;
    let disposed = false;
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    let manualClose = false;

    const sendInput = (d) => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ t: 'i', d }));
      }
    };
    const sendResize = () => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ t: 'z', c: terminal.cols, r: terminal.rows }));
      }
    };

    const connect = () => {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        reconnectAttempts = 0;
        // Report our initial size so the attach PTY + tmux window match.
        sendResize();
      };
      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.t === 'b') {
          // First-frame scrollback snapshot. Reset + write so reconnect also
          // restores history cleanly.
          receivedFirstFrame = true;
          terminal.reset();
          if (typeof msg.d === 'string') terminal.write(msg.d);
        } else if (msg.t === 'o') {
          if (typeof msg.d === 'string') terminal.write(msg.d);
        } else if (msg.t === 'c') {
          terminal.clear();
        }
      };
      ws.onclose = (event) => {
        ws = null;
        if (disposed || manualClose) return;
        // 4010 = tmux session exited — no point reconnecting.
        if (event.code === 4010) {
          if (receivedFirstFrame) {
            // Session ended after we were attached; surface it.
            terminal.write('\r\n\x1b[33m[tmux session exited]\x1b[0m\r\n');
          }
          return;
        }
        // Transient disconnect — exponential backoff reconnect (5 attempts).
        if (reconnectAttempts < 5) {
          const delay = Math.min(250 * Math.pow(2, reconnectAttempts), 2000);
          reconnectAttempts++;
          reconnectTimer = setTimeout(connect, delay);
        }
      };
      ws.onerror = () => {
        /* close handler drives reconnect */
      };
    };

    // --- input: xterm native textarea (works on mobile via its own machinery) ---
    terminal.onData((d) => sendInput(d));

    // --- resize: FitAddon + self-contained visualViewport listener ---
    // (Deliberately NOT reusing mobile-handlers.js KeyboardHandler, which is
    // hardcoded to #terminalContainer / app.terminal / the main session resize
    // endpoint. This viewer has its own dedicated listeners, cleaned up on close.)
    const onResize = () => {
      try {
        fitAddon.fit();
      } catch {
        /* ignore */
      }
      sendResize();
    };
    window.addEventListener('resize', onResize);
    // visualViewport fires when the mobile soft keyboard opens/closes — refit.
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onResize);
    }

    connect();

    // --- stash state for closeExternalTmuxViewer ---
    this._externalTmuxViewer = {
      terminal,
      fitAddon,
      overlay,
      cleanup: () => {
        disposed = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        window.removeEventListener('resize', onResize);
        if (window.visualViewport) {
          window.visualViewport.removeEventListener('resize', onResize);
        }
        manualClose = true;
        if (ws) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          ws = null;
        }
        try {
          terminal.dispose();
        } catch {
          /* ignore */
        }
        overlay.classList.remove('open');
        this._externalTmuxViewer = null;
      },
    };
  },

  closeExternalTmuxViewer() {
    if (this._externalTmuxViewer) {
      this._externalTmuxViewer.cleanup();
    }
  },
});
