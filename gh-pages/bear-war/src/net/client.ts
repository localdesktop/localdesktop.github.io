import { PROTOCOL_VERSION, type C2S, type S2C } from './protocol.ts';

/** Thin WebSocket wrapper with JSON messages and RTT measurement. */
export class NetClient {
  ws: WebSocket | null = null;
  id = '';
  url = '';
  rtt = 0;
  motd = '';
  private handlers = new Set<(m: S2C) => void>();
  private closeHandlers = new Set<() => void>();
  private pingTimer = 0;

  connect(url: string, name: string): Promise<void> {
    this.url = url;
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(e);
        return;
      }
      this.ws = ws;
      const timer = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.close();
          reject(new Error('Connection timed out'));
        }
      }, 8000);
      ws.onopen = () => this.send({ t: 'hello', name, v: PROTOCOL_VERSION, sim: __SIM_HASH__ });
      ws.onmessage = (ev) => {
        let m: S2C;
        try {
          m = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (m.t === 'error' && !settled) {
          // refused during the handshake (e.g. version mismatch)
          settled = true;
          window.clearTimeout(timer);
          reject(new Error(m.msg));
          ws.close();
          return;
        }
        if (m.t === 'welcome') {
          this.id = m.id;
          this.motd = m.motd ?? '';
          if (!settled) {
            settled = true;
            window.clearTimeout(timer);
            resolve();
          }
        }
        if (m.t === 'pong') this.rtt = performance.now() - m.at;
        for (const h of this.handlers) h(m);
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          reject(new Error('Could not connect to server'));
        }
      };
      ws.onclose = () => {
        window.clearInterval(this.pingTimer);
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          reject(new Error('Connection closed'));
        }
        for (const h of this.closeHandlers) h();
      };
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping', at: performance.now() }), 2000);
    });
  }

  get open(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  send(m: C2S): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  on(fn: (m: S2C) => void): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  onClose(fn: () => void): () => void {
    this.closeHandlers.add(fn);
    return () => this.closeHandlers.delete(fn);
  }

  close(): void {
    window.clearInterval(this.pingTimer);
    this.handlers.clear();
    this.closeHandlers.clear();
    this.ws?.close();
    this.ws = null;
  }
}

/** Default server: same host as the page (the bundled server), or a build-time override. */
export function defaultServerUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_SERVER_URL;
  if (env) return env;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}
