/**
 * Browser: the top-level handle. Launches Chrome, opens the CDP socket, and
 * hands out Page objects attached via flat sessions.
 */
import { launchChrome, type LaunchOptions, type LaunchResult } from "./launcher.js";
import { CDP } from "./cdp.js";
import { Page } from "./page.js";

export class Browser {
  private constructor(
    private cdp: CDP,
    private launch: LaunchResult,
    private blockPrivate: boolean,
  ) {}

  static async launch(opts: LaunchOptions = {}): Promise<Browser> {
    const launch = await launchChrome(opts);
    const cdp = await CDP.connect(launch.webSocketDebuggerUrl);
    // Default ON: a stealth browser shouldn't let visited sites port-scan your
    // localhost/LAN. Opt out with { blockPrivateNetwork: false }.
    return new Browser(cdp, launch, opts.blockPrivateNetwork ?? true);
  }

  /** Open a fresh tab and return an initialised Page. */
  async newPage(): Promise<Page> {
    const { targetId } = await this.cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const page = new Page(this.cdp, sessionId, targetId);
    await page.init({ maskWebgl: this.launch.maskWebgl, blockPrivateNetwork: this.blockPrivate });
    return page;
  }

  async close() {
    try {
      await this.cdp.send("Browser.close");
    } catch {}
    this.cdp.close();
    this.launch.kill();
  }
}
