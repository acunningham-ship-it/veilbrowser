import { Browser } from "../src/index.js";
const browser = await Browser.launch({ headless: process.env.VEIL_HEADFUL !== "1", windowSize: { width: 1280, height: 1600 } });
try {
  const p = await browser.newPage();
  // raw WebGL + screen, read directly
  await p.goto("data:text/html,<canvas id=c></canvas>");
  const gl = await p.evaluate<any>(`(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return { ctx: false };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return { ctx: true,
      vendor: gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : 0x1F00),
      renderer: gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : 0x1F01),
      screen: [screen.width, screen.height], ua: navigator.userAgent };
  })()`);
  console.log("webgl/screen:", JSON.stringify(gl));

  // sannysoft fails only
  await p.goto("https://bot.sannysoft.com/", { timeout: 45000 });
  await p.waitFor("document.querySelectorAll('td').length > 4", { timeout: 15000 });
  const fails = await p.evaluate<string[]>(`(() => {
    const out = [];
    for (const tr of document.querySelectorAll('tr')) {
      const tds = tr.querySelectorAll('td'); if (tds.length < 2) continue;
      const cell = tds[tds.length-1]; const bg = getComputedStyle(cell).backgroundColor;
      const m = bg.match(/rgba?\\((\\d+), (\\d+), (\\d+)/);
      if (m && +m[1]>150 && +m[2]<120 && +m[3]<120)
        out.push(tds[0].innerText.trim().replace(/\\s+/g,' ') + ' => ' + cell.innerText.trim().slice(0,40));
    } return out; })()`);
  console.log("sannysoft fails:", fails.length ? fails : "NONE");

  // creepjs headless/stealth lines
  const cj = await browser.newPage();
  await cj.goto("https://abrahamjuliot.github.io/creepjs/", { timeout: 45000 });
  for (let i = 0; i < 45; i++) { if (await cj.evaluate<boolean>(`/\\d+%/.test(document.body.innerText)`)) break; await new Promise(r=>setTimeout(r,1000)); }
  await new Promise(r=>setTimeout(r,3000));
  const lines = await cj.evaluate<string[]>(`document.body.innerText.split('\\n').map(s=>s.trim()).filter(s=>/headless|stealth|lies|trust/i.test(s)&&s.length<80)`);
  console.log("creepjs:", lines.join(" | "));
} finally { await browser.close(); }
