/**
 * Browser: the top-level handle. Launches Chrome, opens the CDP socket, and
 * hands out Page objects attached via flat sessions.
 */
import { type LaunchOptions } from "./launcher.js";
import { Page } from "./page.js";
export declare class Browser {
    private cdp;
    private launch;
    private constructor();
    static launch(opts?: LaunchOptions): Promise<Browser>;
    /** Open a fresh tab and return an initialised Page. */
    newPage(): Promise<Page>;
    close(): Promise<void>;
}
