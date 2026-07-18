/**
 * Unit tests for isPrivateHost — the classifier behind blockPrivateNetwork.
 * Pure logic (no browser), so it runs in CI. It decides which requests get
 * blocked, so a wrong answer either leaks localhost or breaks the public web.
 *
 * Run with: bun test tests/private-host.test.ts
 */
import { describe, it, expect } from "bun:test";
import { isPrivateHost } from "../src/page.js";

describe("isPrivateHost — private/loopback (must block)", () => {
  const priv = [
    "http://localhost/",
    "http://localhost:3001/api",
    "https://foo.localhost/",
    "http://127.0.0.1:5900/",
    "http://127.1.2.3/",
    "ws://127.0.0.1:9222/devtools",
    "http://0.0.0.0:8080/",
    "http://10.0.0.5/",
    "http://192.168.1.10/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://169.254.1.1/",
    "http://[::1]:3000/",
    "wss://[::1]/",
    "http://100.64.0.1/",           // 100.64.0.0/10 CGNAT — low edge
    "http://100.106.123.122/",      // this box's own tailnet address
    "http://100.127.255.255/",      // CGNAT — high edge
    "http://[fc00::1]/",            // IPv6 unique-local (fc00::/7)
    "http://[fd12:3456:789a::1]/",  // IPv6 unique-local (fd = fc00::/7)
    "http://[::ffff:127.0.0.1]/",   // IPv4-mapped loopback
    "http://[::ffff:192.168.1.10]/",// IPv4-mapped private LAN
  ];
  for (const u of priv) it(u, () => expect(isPrivateHost(u)).toBe(true));
});

describe("isPrivateHost — public (must NOT block)", () => {
  const pub = [
    "https://example.com/",
    "https://iphey.com/",
    "http://8.8.8.8/",
    "http://172.15.0.1/", // just below the 172.16/12 range
    "http://172.32.0.1/", // just above
    "http://11.0.0.1/",
    "http://193.168.1.1/", // not 192.168
    "http://169.253.0.1/", // not link-local
    "http://100.63.255.255/", // just below the 100.64/10 CGNAT range
    "http://100.128.0.1/", // just above the 100.64/10 CGNAT range
    "http://100.0.0.1/", // public 100/8, well below CGNAT
    "http://[::ffff:8.8.8.8]/", // IPv4-mapped, but public
    "http://[2606:4700:4700::1111]/", // public IPv6 (Cloudflare), not fc00::/7
    "https://localhostess.com/", // hostname merely starts with "localhost"
    "not a url",
  ];
  for (const u of pub) it(u, () => expect(isPrivateHost(u)).toBe(false));
});
