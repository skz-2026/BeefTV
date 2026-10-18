const { chromium } = require("playwright");
(async () => {
    const b = await chromium.launch();
    const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
    await p.goto("http://127.0.0.1:3000/digital-human-book/digitalhuman-paper-001", { waitUntil: "networkidle", timeout: 90000 });
    await p.waitForTimeout(2500);
    const g = p.locator(".first-creation-actions button");
    if (await g.count()) { await g.first().click({ force: true }).catch(() => {}); await p.waitForTimeout(500); }
    await p.waitForTimeout(2500);
    const info = await p.$$eval("[data-canvas-node]", (els) => els.slice(0, 10).map((e) => ({
        id: e.getAttribute("data-node-id"),
        left: e.style.left, top: e.style.top, w: e.style.width, h: e.style.height,
    })));
    console.log(JSON.stringify(info, null, 1));
    await b.close();
})();
