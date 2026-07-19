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
type EventHandler = (params: any) => void;
export declare class CDP {
    private url;
    /** Default per-command timeout (ms). Overridable per-call and via `defaultTimeout`. */
    static DEFAULT_TIMEOUT: number;
    /** Per-instance override for the command timeout applied when a call passes none. */
    defaultTimeout: number;
    private ws;
    private nextId;
    private pending;
    private handlers;
    private closed;
    private constructor();
    static connect(webSocketDebuggerUrl: string): Promise<CDP>;
    private open;
    private onMessage;
    /**
     * Send a CDP command. Optionally scoped to a session (page target).
     *
     * Rejects after `timeoutMs` (default `defaultTimeout`, 30s) if no response
     * arrives — a hung renderer never replies, so without this the promise would
     * never settle. A `timeoutMs <= 0` disables the timeout. The pending entry is
     * always removed on timeout, on a `ws.send` throw (socket CLOSING/CLOSED), and
     * on response — so the `pending` map can't leak.
     */
    send<T = any>(method: string, params?: Record<string, any>, sessionId?: string, timeoutMs?: number): Promise<T>;
    /** Subscribe to an event. Pass sessionId, or "*" to match any session. */
    on(method: string, handler: EventHandler, sessionId?: string): () => void;
    /** Resolve once an event fires (with optional predicate / timeout). */
    once(method: string, opts?: {
        sessionId?: string;
        predicate?: (p: any) => boolean;
        timeout?: number;
    }): Promise<any>;
    /** Remove all handlers for a specific sessionId. Called on page close to prevent accumulation. */
    clearHandlers(sessionId: string): void;
    close(): void;
}
export {};
