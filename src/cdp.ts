/**
 * Raw Chrome DevTools Protocol client.
 *
 * No puppeteer, no playwright, no chrome-remote-interface. Just a WebSocket and
 * the protocol. We use "flat" session mode (Target.attachToTarget {flatten:true})
 * so every command/event is tagged with a sessionId and we can talk to the
 * browser and any number of page targets over a single socket.
 *
 * Crucially: we never call `Runtime.enable`. That command is one of the loudest
 * automation tells on the web (it creates a detectable execution-context binding
 * and fires events sites listen for). `Runtime.evaluate` works fine without it.
 */

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  method: string;
  timer?: ReturnType<typeof setTimeout>;
};
type EventHandler = (params: any) => void;

export class CDP {
  /** Default per-command timeout (ms). Overridable per-call and via `defaultTimeout`. */
  static DEFAULT_TIMEOUT = 30000;
  /** Per-instance override for the command timeout applied when a call passes none. */
  defaultTimeout = CDP.DEFAULT_TIMEOUT;
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  // key: `${sessionId ?? ""}:${method}` -> set of handlers
  private handlers = new Map<string, Set<EventHandler>>();
  private closed = false;

  private constructor(private url: string) {}

  static async connect(webSocketDebuggerUrl: string): Promise<CDP> {
    const cdp = new CDP(webSocketDebuggerUrl);
    await cdp.open();
    return cdp;
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e: any) =>
        reject(new Error(`CDP socket error: ${e?.message ?? "unknown"}`)),
      );
      this.ws.addEventListener("close", () => {
        this.closed = true;
        for (const { reject, timer } of this.pending.values()) {
          if (timer) clearTimeout(timer);
          reject(new Error("CDP connection closed"));
        }
        this.pending.clear();
      });
      this.ws.addEventListener("message", (ev: any) => this.onMessage(String(ev.data)));
    });
  }

  private onMessage(data: string) {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message} (${msg.error.code})`));
      else p.resolve(msg.result);
      return;
    }
    // Event. Dispatch to handlers keyed with and without sessionId.
    if (msg.method) {
      const sid = msg.sessionId ?? "";
      for (const key of [`${sid}:${msg.method}`, `*:${msg.method}`]) {
        const set = this.handlers.get(key);
        if (set) for (const h of [...set]) h(msg.params ?? {});
      }
    }
  }

  /**
   * Send a CDP command. Optionally scoped to a session (page target).
   *
   * Rejects after `timeoutMs` (default `defaultTimeout`, 30s) if no response
   * arrives — a hung renderer never replies, so without this the promise would
   * never settle. A `timeoutMs <= 0` disables the timeout. The pending entry is
   * always removed on timeout, on a `ws.send` throw (socket CLOSING/CLOSED), and
   * on response — so the `pending` map can't leak.
   */
  send<T = any>(
    method: string,
    params: Record<string, any> = {},
    sessionId?: string,
    timeoutMs: number = this.defaultTimeout,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    const id = this.nextId++;
    const payload: any = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          // Only reject if still pending — a late-arriving response could have
          // resolved and deleted us already.
          if (this.pending.delete(id))
            reject(new Error(`${method}: timed out after ${timeoutMs}ms (no CDP response)`));
        }, timeoutMs);
        // Don't let a pending command keep the process alive on its own.
        (timer as any)?.unref?.();
      }
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e: any) {
        // Socket in CLOSING/CLOSED throws synchronously — clear the timer and the
        // orphaned pending entry so it doesn't leak, then surface the error.
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`${method}: failed to send command (${e?.message ?? "socket error"})`));
      }
    });
  }

  /** Subscribe to an event. Pass sessionId, or "*" to match any session. */
  on(method: string, handler: EventHandler, sessionId = "*"): () => void {
    const key = `${sessionId}:${method}`;
    let set = this.handlers.get(key);
    if (!set) this.handlers.set(key, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Resolve once an event fires (with optional predicate / timeout). */
  once(method: string, opts: { sessionId?: string; predicate?: (p: any) => boolean; timeout?: number } = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const off = this.on(
        method,
        (p) => {
          if (opts.predicate && !opts.predicate(p)) return;
          clearTimeout(timer);
          off();
          resolve(p);
        },
        opts.sessionId ?? "*",
      );
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for ${method}`));
      }, opts.timeout ?? 30000);
    });
  }

  /** Remove all handlers for a specific sessionId. Called on page close to prevent accumulation. */
  clearHandlers(sessionId: string) {
    // Remove all handlers keyed with this sessionId
    const prefix = `${sessionId}:`;
    for (const key of this.handlers.keys()) {
      if (key.startsWith(prefix)) {
        this.handlers.delete(key);
      }
    }
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {}
  }
}
