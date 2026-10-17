// Minimal Chrome DevTools Protocol client over WebSocket.
// Zero external deps: uses the global WebSocket (Node >= 22).
// The socket is injectable so the protocol layer is unit-testable
// without a real browser.

/** The narrow slice of WebSocket behaviour the CDP client needs. */
export interface CdpSocket {
  send(data: string): void;
  close(): void;
  onmessage: ((data: string) => void) | null;
  onopen: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
}

function defaultSocketFactory(url: string): CdpSocket {
  const ws = new WebSocket(url);
  const socket: CdpSocket = {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onmessage: null,
    onopen: null,
    onerror: null,
  };
  ws.addEventListener('message', (ev) => socket.onmessage?.(String(ev.data)));
  ws.addEventListener('open', () => socket.onopen?.());
  ws.addEventListener('error', (ev) => socket.onerror?.(ev));
  return socket;
}

export interface CdpConnection {
  /** Send a CDP command; resolves with `result`, rejects on CDP `error`. */
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Subscribe to a CDP event (e.g. `Page.loadEventFired`). Returns an unsubscribe fn. */
  on(method: string, handler: (params: Record<string, unknown>) => void): () => void;
  close(): void;
}

export interface ConnectCdpOptions {
  /** Per-request timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /** Injectable for tests. */
  socketFactory?: (url: string) => CdpSocket;
}

interface CdpResponse {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown };
  method?: unknown;
  params?: unknown;
}

/**
 * Connect to a CDP WebSocket endpoint (e.g. a `webSocketDebuggerUrl` from
 * `http://localhost:9222/json/list`). Resolves once the socket is open.
 */
export async function connectCdp(url: string, opts: ConnectCdpOptions = {}): Promise<CdpConnection> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const socket = (opts.socketFactory ?? defaultSocketFactory)(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`CDP connect timed out after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = (err) => {
      clearTimeout(timer);
      reject(
        new Error(`CDP connect failed for ${url}: ${err instanceof Error ? err.message : 'websocket error'}`),
      );
    };
  });

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const subs = new Map<string, Set<(params: Record<string, unknown>) => void>>();

  const failPending = (err: Error): void => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  };

  socket.onmessage = (data) => {
    let msg: CdpResponse;
    try {
      msg = JSON.parse(data) as CdpResponse;
    } catch {
      return; // not a CDP frame; ignore
    }
    if (typeof msg.id === 'number') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const detail =
          typeof msg.error.message === 'string' ? msg.error.message : JSON.stringify(msg.error);
        p.reject(new Error(`CDP error: ${detail}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === 'string') {
      const handlers = subs.get(msg.method);
      if (handlers) {
        const params = (msg.params ?? {}) as Record<string, unknown>;
        for (const h of handlers) {
          try {
            h(params);
          } catch {
            // Subscriber errors never break dispatch.
          }
        }
      }
    }
  };
  socket.onerror = (err) => {
    failPending(new Error(`CDP socket error: ${err instanceof Error ? err.message : 'websocket error'}`));
  };

  return {
    send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP request timed out after ${timeoutMs}ms: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    on(method: string, handler: (params: Record<string, unknown>) => void): () => void {
      let set = subs.get(method);
      if (!set) {
        set = new Set();
        subs.set(method, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
    close(): void {
      failPending(new Error('CDP connection closed'));
      socket.close();
    },
  };
}

/**
 * Resolve a CDP endpoint to a WebSocket URL. Accepts `ws://…` directly, or an
 * `http(s)://host:port` DevTools endpoint (the `/json/list` discovery page is
 * queried for the first `page` target).
 */
export async function resolveCdpWebSocketUrl(
  base: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (base.startsWith('ws://') || base.startsWith('wss://')) return base;
  const discovery = base.replace(/\/+$/, '') + '/json/list';
  let res: Response;
  try {
    res = await fetchImpl(discovery);
  } catch (err) {
    throw new Error(`CDP discovery failed at ${discovery}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new Error(`CDP discovery failed: HTTP ${res.status} at ${discovery}`);
  }
  const targets = (await res.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) {
    throw new Error(
      'CDP discovery: no page target found — is Chromium running with --remote-debugging-port? (see docs/BROWSER.md)',
    );
  }
  return page.webSocketDebuggerUrl;
}
