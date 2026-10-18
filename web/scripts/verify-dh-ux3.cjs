// 走查第二轮：右栏画布尺寸 + 画布返回入口位置 + 换段（P05）返回定位
const { chromium } = require("playwright");
const BOOK = "digitalhuman-paper-001";
(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const r = {};
    await page.goto(`http://127.0.0.1:3000/digital-human-book/${BOOK}`, { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForTimeout(2500);
    const guide = page.locator(".first-creation-actions button");
    if (await guide.count()) { await guide.first().click({ force: true }).catch(() => {}); await page.waitForTimeout(600); }
    await page.waitForTimeout(2500);
    // 画布视口实际尺寸与缩放
    r.canvasBox = await page.locator("[data-canvas-viewport]").first().boundingBox();
    r.zoomLabel = await page.locator("[data-canvas-viewport] button[title^='适应画布']").first().textContent().catch(() => "");
    await page.screenshot({ path: "../.local/ux3-1-panel.png" });

    // 切到 P05 并进入画布，验证 ?seg 返回定位
    const segBtn = page.locator("button[aria-pressed]", { hasText: "P05" }).first();
    await segBtn.click({ force: true });
    await page.waitForTimeout(2500);
    await page.locator("[data-node-id='seg-P05']").first().hover({ force: true });
    await page.waitForTimeout(500);
    await page.locator("[data-node-id='seg-P05'] button[title^='进入画布']").first().click({ force: true });
    await page.waitForURL(/\/canvas\//, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);
    r.canvasUrl = page.url();
    r.pillBox = await page.locator("a[title^='返回生产页']").first().boundingBox();
    r.topBarBox = await page.locator("header").first().boundingBox().catch(() => null);
    await page.screenshot({ path: "../.local/ux3-2-canvas.png" });
    await page.locator("a[title^='返回生产页']").first().click();
    await page.waitForURL(/digital-human-book/, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const pressed = await page.$$eval("button[aria-pressed='true']", (els) => els.map((e) => (e.textContent || "").slice(0, 8)));
    r.selectedAfterBack = pressed;
    await page.screenshot({ path: "../.local/ux3-3-back.png" });
    console.log(JSON.stringify(r, null, 2));
    await browser.close();
})();
