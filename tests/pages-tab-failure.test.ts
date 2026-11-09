/** pages(): one tab refusing setup is skipped; the others still come back, guarded. No Chrome: fake CDP. */
import { it, expect } from "bun:test";
import { Browser } from "../src/index.js";

function fakeCdp(refuse: { method: string; session: string }) {
  const sent: Array<[string, string | undefined]> = [];
  return {
    sent,
    isClosed: false,
    on() {}, once() {}, off() {}, clearHandlers() {},
    async send(method: string, _p: any = {}, sessionId?: string) {
      sent.push([method, sessionId ?? _p.sessionId]);
      if (method === "Target.getTargets")
        return { targetInfos: ["A", "B", "C"].map((id) => ({ type: "page", targetId: id, url: `https://${id}.test/` })) };
      if (method === "Target.attachToTarget") return { sessionId: `s-${_p.targetId}` };
      if (method === refuse.method && sessionId === refuse.session) throw new Error("Target closed");
      return {};
    },
  };
}
const make = (cdp: any) => new (Browser as any)(cdp, { kill() {} }, true, ["a.test"], undefined, true) as Browser;

for (const method of ["Page.enable", "Fetch.enable"]) {
  it(`a tab whose ${method} throws is skipped and detached; the other two are returned with guards on`, async () => {
    const cdp = fakeCdp({ method, session: "s-B" });
    const pages = await make(cdp).pages();
    expect(pages.map((p: any) => p.targetId)).toEqual(["A", "C"]);
    expect(cdp.sent).toContainEqual(["Target.detachFromTarget", "s-B"]);
    for (const s of ["s-A", "s-C"]) expect(cdp.sent).toContainEqual(["Fetch.enable", s]); // guards really applied
  });
}
