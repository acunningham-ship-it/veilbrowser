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
export declare class Rng {
    private s;
    constructor(seed?: number);
    next(): number;
    range(min: number, max: number): number;
    int(min: number, max: number): number;
}
export interface Point {
    x: number;
    y: number;
}
/**
 * Sample a curved path from `from` to `to` using a quadratic Bézier whose control
 * point is offset perpendicular to the travel direction — the gentle arc a real
 * hand makes. Returns ~steps points with eased spacing (slow-fast-slow).
 */
export declare function mousePath(from: Point, to: Point, rng: Rng): Point[];
/** Per-step delay (ms) for mouse moves — short, slightly jittered. */
export declare function moveDelay(rng: Rng): number;
/** Per-character delay (ms) for typing — human burst-and-pause cadence. */
export declare function keyDelay(rng: Rng, char: string): number;
export declare const sleep: (ms: number) => Promise<unknown>;
