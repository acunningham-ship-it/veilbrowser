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
export class CDP {
    url;
    ws;
    nextId = 1;
    pending = new Map();
    // key: `${sessionId ?? ""}:${method}` -> set of handlers
    handlers = new Map();
    closed = false;
    constructor(url) {
        this.url = url;
    }
    static async connect(webSocketDebuggerUrl) {
        const cdp = new CDP(webSocketDebuggerUrl);
        await cdp.open();
        return cdp;
    }
    open() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url);
            this.ws.addEventListener("open", () => resolve());
            this.ws.addEventListener("error", (e) => reject(new Error(`CDP socket error: ${e?.message ?? "unknown"}`)));
            this.ws.addEventListener("close", () => {
                this.closed = true;
                for (const { reject } of this.pending.values())
                    reject(new Error("CDP connection closed"));
                this.pending.clear();
            });
            this.ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
        });
    }
    onMessage(data) {
        let msg;
        try {
            msg = JSON.parse(data);
        }
        catch {
            return;
        }
        if (typeof msg.id === "number") {
            const p = this.pending.get(msg.id);
            if (!p)
                return;
            this.pending.delete(msg.id);
            if (msg.error)
                p.reject(new Error(`${p.method}: ${msg.error.message} (${msg.error.code})`));
            else
                p.resolve(msg.result);
            return;
        }
        // Event. Dispatch to handlers keyed with and without sessionId.
        if (msg.method) {
            const sid = msg.sessionId ?? "";
            for (const key of [`${sid}:${msg.method}`, `*:${msg.method}`]) {
                const set = this.handlers.get(key);
                if (set)
                    for (const h of [...set])
                        h(msg.params ?? {});
            }
        }
    }
    /** Send a CDP command. Optionally scoped to a session (page target). */
    send(method, params = {}, sessionId) {
        if (this.closed)
            return Promise.reject(new Error("CDP connection closed"));
        const id = this.nextId++;
        const payload = { id, method, params };
        if (sessionId)
            payload.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, method });
            this.ws.send(JSON.stringify(payload));
        });
    }
    /** Subscribe to an event. Pass sessionId, or "*" to match any session. */
    on(method, handler, sessionId = "*") {
        const key = `${sessionId}:${method}`;
        let set = this.handlers.get(key);
        if (!set)
            this.handlers.set(key, (set = new Set()));
        set.add(handler);
        return () => set.delete(handler);
    }
    /** Resolve once an event fires (with optional predicate / timeout). */
    once(method, opts = {}) {
        return new Promise((resolve, reject) => {
            const off = this.on(method, (p) => {
                if (opts.predicate && !opts.predicate(p))
                    return;
                clearTimeout(timer);
                off();
                resolve(p);
            }, opts.sessionId ?? "*");
            const timer = setTimeout(() => {
                off();
                reject(new Error(`Timed out waiting for ${method}`));
            }, opts.timeout ?? 30000);
        });
    }
    close() {
        this.closed = true;
        try {
            this.ws.close();
        }
        catch { }
    }
}
