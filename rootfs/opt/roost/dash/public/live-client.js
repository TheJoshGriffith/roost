'use strict';
// roost chat: browser-side controller for one chat. It knows nothing about markup:
// it loads history, follows the live event stream (with reconnect + catch-up), and
// sends actions, calling `onEvent(ev, {replay})` and `onState(state)` for the view.

window.RoostLive = (() => {
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: method === 'GET' ? {} : { 'X-Roost': '1', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let j = null;
    try { j = await res.json(); } catch {}
    if (!res.ok) throw new Error((j && j.error) || res.statusText);
    return j;
  }

  class Chat {
    // opts: { key?, tool, project?, dir?, model?, mode?, onEvent, onState }
    constructor(opts) {
      this.opts = opts;
      this.tool = opts.tool || (opts.key ? opts.key.split(':')[0] : 'claude');
      this.key = opts.key || null;        // claude:<id> once known
      this.streamKey = null;             // the key the event stream is attached to
      this.seq = 0;
      this.es = null;
      this.state = { status: opts.key ? 'offline' : 'new', live: false, model: opts.model || '', mode: opts.mode || (this.tool === 'claude' ? 'default' : 'ask'), pending: 0 };
      this.closed = false;
    }

    setState(patch) {
      Object.assign(this.state, patch);
      if (this.opts.onState) this.opts.onState({ ...this.state });
    }

    emit(ev, replay) { if (!this.closed && this.opts.onEvent) this.opts.onEvent(ev, { replay: !!replay }); }

    // Load the saved conversation, then follow it live.
    async open() {
      if (this.key) {
        try {
          const { events } = await api('GET', `api/live/history?key=${encodeURIComponent(this.key)}`);
          for (const ev of events) this.emit(ev, true);
        } catch (e) {
          this.emit({ t: 'notice', level: 'error', text: `Couldn't load history: ${e.message}` }, true);
        }
        this.connect(this.key, true);
      }
      this.setState({});
    }

    connect(key, skipReplayOfHistory) {
      if (this.es && this.streamKey === key) return;
      if (this.es) this.es.close();
      this.streamKey = key;
      // A chat opened from history that is live in roost replays its live events; those
      // overlap the transcript we just rendered, so skip events from before we opened.
      this.skipBefore = skipReplayOfHistory ? Date.now() : 0;
      const es = new EventSource(`api/live/stream?key=${encodeURIComponent(key)}&since=${this.seq}`);
      this.es = es;
      es.onmessage = (m) => {
        let ev;
        try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.t === 'snapshot') {
          this.setState({ status: ev.status, live: ev.live, model: ev.model ?? this.state.model, mode: ev.mode ?? this.state.mode });
          return;
        }
        if (ev.seq) this.seq = Math.max(this.seq, ev.seq);
        if (this.skipBefore && ev.at && ev.at < this.skipBefore && ev.t !== 'permission' && ev.t !== 'permission-resolved') return;
        if (ev.t === 'status') this.setState({ status: ev.status, live: ev.status !== 'closed' });
        if (ev.t === 'session') {
          this.key = ev.key;
          this.setState({ model: ev.model || this.state.model });
          if (this.opts.onKey) this.opts.onKey(ev.key);
        }
        if (ev.t === 'permission') this.setState({ pending: this.state.pending + 1 });
        if (ev.t === 'permission-resolved') this.setState({ pending: Math.max(0, this.state.pending - 1) });
        this.emit(ev, false);
      };
      es.onerror = () => { if (!this.closed) this.setState({ connection: 'reconnecting' }); };
      es.onopen = () => this.setState({ connection: 'ok' });
    }

    async send(text) {
      const body = { key: this.key || undefined, tool: this.tool, text };
      if (!this.key) Object.assign(body, { project: this.opts.project, dir: this.opts.dir, model: this.state.model || undefined, mode: this.state.mode });
      this.setState({ status: 'starting' });
      const r = await api('POST', 'api/live/send', body);
      if (!this.key && r.key && !r.key.includes(':new-')) this.key = r.key;
      // Follow the stream under the key the server registered first (works before the real id is known).
      this.connect(r.pendingKey || r.key, false);
      return r;
    }

    interrupt() { return api('POST', 'api/live/interrupt', { key: this.streamKey || this.key }); }
    answer(id, decision, message) { return api('POST', 'api/live/permission', { key: this.streamKey || this.key, id, decision, message }); }

    async settings(patch) {
      this.setState(patch);
      if (this.state.live && (this.streamKey || this.key)) {
        try { await api('POST', 'api/live/settings', { key: this.streamKey || this.key, ...patch }); } catch {}
      }
    }

    async stop() { // end the background process (history stays)
      if (this.streamKey || this.key) await api('POST', 'api/live/close', { key: this.streamKey || this.key }).catch(() => {});
      this.setState({ status: 'offline', live: false });
    }

    dispose() {
      this.closed = true;
      if (this.es) this.es.close();
      this.es = null;
    }
  }

  return { Chat, api };
})();
