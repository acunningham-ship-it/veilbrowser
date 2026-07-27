/**
 * Origin allowlist — the mechanism behind the `Browser.connect()` warning.
 *
 * Raised by u/zhonglin on r/AI_Agents: attaching to a signed-in Chrome puts the whole
 * cookie jar inside the agent's trust boundary. An agent told "check my Amazon order"
 * can navigate to mail.google.com and read it, because it is the same browser with the
 * same sessions. Docs asked the operator to be careful; this is the enforcement.
 *
 * Contract:
 *   - DOCUMENT navigation (top-level AND sub-frame) outside the list -> AccessDenied
 *   - subresources are NOT gated (a real page pulls CDN assets from other origins; a
 *     guard that breaks every site gets switched off, which protects nothing)
 *   - entries match host + subdomains, on a DOT boundary: "github.com" covers
 *     api.github.com but NOT notgithub.com
 *
 * The integration half uses two loopback HOSTNAMES (127.0.0.1 vs localhost) on one
 * local server, so it needs no network and no second port. blockPrivateNetwork is off
 * for those cases, otherwise the private-network guard answers first.
 *
 * Run: DISPLAY=:98 bun test tests/origin-allowlist.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser, isOriginAllowed } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;

describe("isOriginAllowed", () => {
  it("is unrestricted when the list is empty", () => {
    expect(isOriginAllowed("https://anything.example", [])).toBe(true);
  });

  it("matches the host itself and its subdomains", () => {
    expect(isOriginAllowed("https://github.com/x", ["github.com"])).toBe(true);
    expect(isOriginAllowed("https://api.github.com/x", ["github.com"])).toBe(true);
    expect(isOriginAllowed("https://deep.api.github.com/", ["github.com"])).toBe(true);
  });

  it("does NOT match a lookalike suffix — the classic hole", () => {
    expect(isOriginAllowed("https://notgithub.com/", ["github.com"])).toBe(false);
    expect(isOriginAllowed("https://github.com.evil.tld/", ["github.com"])).toBe(false);
    expect(isOriginAllowed("https://evilgithub.com/", ["github.com"])).toBe(false);
  });

  it("blocks an unlisted origin", () => {
    expect(isOriginAllowed("https://mail.google.com/", ["github.com"])).toBe(false);
  });

  it("tolerates a full origin, a port, a path, and a leading *. in an entry", () => {
    for (const entry of ["https://github.com", "github.com:443", "github.com/org/repo", "*.github.com"]) {
      expect(isOriginAllowed("https://api.github.com/", [entry])).toBe(true);
    }
  });

  it("leaves non-http(s) alone — about:blank is how a tab starts", () => {
    expect(isOriginAllowed("about:blank", ["github.com"])).toBe(true);
    expect(isOriginAllowed("data:text/html,hi", ["github.com"])).toBe(true);
  });

  it("is case-insensitive on host", () => {
    expect(isOriginAllowed("https://API.GitHub.COM/", ["github.com"])).toBe(true);
  });
});

describe.skipIf(!!process.env.CI)("origin allowlist in a real browser", () => {
  let server: ReturnType<typeof Bun.serve>;
  let port = 0;
  let browser: Browser | undefined;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/pixel.png") {
          // 1x1 gif is fine; the test only cares that the request was not blocked
          return new Response(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"), {
            headers: { "content-type": "image/gif" },
          });
        }
        return new Response("<h1>ok</h1>", { headers: { "content-type": "text/html" } });
      },
    });
    port = server.port;
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  const open = async (allowOrigins: string[]): Promise<Page> => {
    await browser?.close();
    browser = await Browser.launch({ headless: true, blockPrivateNetwork: false, allowOrigins });
    return browser.newPage();
  };

  it("allows navigation to a listed host", async () => {
    const page = await open(["127.0.0.1"]);
    await page.goto(`http://127.0.0.1:${port}/`);
    expect(await page.evaluate<string>("document.body.innerText")).toContain("ok");
  }, TIMEOUT);

  it("blocks navigation to an unlisted host", async () => {
    const page = await open(["127.0.0.1"]);
    await page.goto(`http://127.0.0.1:${port}/`); // land somewhere allowed first
    await page.goto(`http://localhost:${port}/`).catch(() => {}); // same server, other hostname
    // The page must NOT have landed on the blocked host.
    expect(await page.evaluate<string>("location.hostname")).not.toBe("localhost");
  }, TIMEOUT);

  it("still loads a SUBRESOURCE from an unlisted host (navigation-only by design)", async () => {
    const page = await open(["127.0.0.1"]);
    await page.goto(`http://127.0.0.1:${port}/`);
    const loaded = await page.evaluate<boolean>(`new Promise((res) => {
      const img = new Image();
      img.onload = () => res(true);
      img.onerror = () => res(false);
      img.src = "http://localhost:${port}/pixel.png";
    })`);
    expect(loaded).toBe(true);
  }, TIMEOUT);

  it("is unrestricted when no allowlist is configured", async () => {
    const page = await open([]);
    await page.goto(`http://localhost:${port}/`);
    expect(await page.evaluate<string>("location.hostname")).toBe("localhost");
  }, TIMEOUT);
});
