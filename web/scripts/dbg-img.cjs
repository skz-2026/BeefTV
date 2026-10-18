const { chromium } = require("playwright");
(async () => {
    const b = await chromium.launch();
    const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
    await p.goto("http://127.0.0.1:3000/digital-human-book/digitalhuman-paper-001", { waitUntil: "networkidle", timeout: 90000 });
    await p.waitForTimeout(2500);
    const g = p.locator(".first-creation-actions button");
    if (await g.count()) { await g.first().click({ force: true }).catch(() => {}); await p.waitForTimeout(500); }
    await p.waitForTimeout(2500);
    for (const id of ["scene-S1", "wf-frame", "seg-P01"]) {
        const wrap = await p.locator(`[data-node-id='${id}']`).first().boundingBox();
        const img = await p.locator(`[data-node-id='${id}'] img`).first().boundingBox().catch(() => null);
        const video = await p.locator(`[data-node-id='${id}'] video`).first().boundingBox().catch(() => null);
        console.log(id, "wrap", JSON.stringify(wrap), "img", JSON.stringify(img), "video", JSON.stringify(video));
    }
    await b.close();
})();
