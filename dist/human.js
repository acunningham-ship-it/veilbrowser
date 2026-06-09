/**
 * Human-like input timing.
 *
 * Robotic automation moves the mouse in straight teleports and types at a
 * perfectly fixed cadence. Behavioural-fingerprinting scripts (Akamai, PerimeterX,
 * Datadome) watch for exactly that. We move along a curved path with eased,
 * jittered timing and vary keystroke intervals around human norms.
 *
 * Determinism note: we draw randomness from a seedable PRNG so runs can be made
 * reproducible for tests, while still being non-uniform on the wire.
 */
export class Rng {
    s;
    constructor(seed = (Date.now() ^ (process.pid << 16)) >>> 0) {
        this.s = seed >>> 0 || 1;
    }
    next() {
        // xorshift32
        let x = this.s;
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        this.s = x >>> 0;
        return this.s / 0xffffffff;
    }
    range(min, max) {
        return min + this.next() * (max - min);
    }
    int(min, max) {
        return Math.floor(this.range(min, max + 1));
    }
}
/**
 * Sample a curved path from `from` to `to` using a quadratic Bézier whose control
 * point is offset perpendicular to the travel direction — the gentle arc a real
 * hand makes. Returns ~steps points with eased spacing (slow-fast-slow).
 */
export function mousePath(from, to, rng) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(8, Math.min(40, Math.round(dist / 12)));
    // Perpendicular control-point offset, scaled to distance, signed randomly.
    const mag = Math.min(dist * 0.18, 60) * (rng.next() < 0.5 ? -1 : 1) * rng.range(0.4, 1);
    const mx = (from.x + to.x) / 2 + (-dy / (dist || 1)) * mag;
    const my = (from.y + to.y) / 2 + (dx / (dist || 1)) * mag;
    const pts = [];
    for (let i = 1; i <= steps; i++) {
        let t = i / steps;
        // ease-in-out so the cursor accelerates then settles
        t = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const u = 1 - t;
        const x = u * u * from.x + 2 * u * t * mx + t * t * to.x;
        const y = u * u * from.y + 2 * u * t * my + t * t * to.y;
        // sub-pixel jitter
        pts.push({ x: x + rng.range(-0.6, 0.6), y: y + rng.range(-0.6, 0.6) });
    }
    pts[pts.length - 1] = { x: to.x, y: to.y }; // land exactly on target
    return pts;
}
/** Per-step delay (ms) for mouse moves — short, slightly jittered. */
export function moveDelay(rng) {
    return rng.range(4, 12);
}
/** Per-character delay (ms) for typing — human burst-and-pause cadence. */
export function keyDelay(rng, char) {
    if (char === " ")
        return rng.range(60, 140);
    if (/[.,!?]/.test(char))
        return rng.range(120, 260); // micro-pause at punctuation
    return rng.range(45, 130);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
