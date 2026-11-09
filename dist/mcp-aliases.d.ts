export declare const NEW_ALIASES: Record<string, Record<string, string>>;
/** Rewrite aliased keys to canonical ones (new table first, then the legacy one). */
export declare function normalizeArgs(name: string, args: any): any;
