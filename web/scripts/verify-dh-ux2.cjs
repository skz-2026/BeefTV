const { chromium } = require("playwright");
const BOOK = "digitalhuman-paper-001";
const OUT = "../.local/ux2";
(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 120)}`); });
    const r = {};
    const shot = (n) => page.screenshot({ path: `${OUT}-${n}.png` });

    await page.goto(`http://127.0.0.1:3000/digital-human-book/${BOOK}`, { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForTimeout(2500);
    const guide = page.locator(".first-creation-actions button");
    if (await guide.count()) { await guide.first().click({ force: true }).catch(() => {}); await page.waitForTimeout(600); }
    await page.waitForTimeout(2000);

    // 悬停段视频节点 → 「画布」按钮出现
    const segNode = page.locator("[data-node-id='seg-P01']").first();
    await segNode.hover({ force: true });
    await page.waitForTimeout(600);
    const openBtn = page.locator("[data-node-id='seg-P01'] button[title^='进入画布']").first();
    r.hoverButtonVisible = await openBtn.count() > 0;
    await shot("1-hover");
    if (r.hoverButtonVisible) {
        await openBtn.click({ force: true });
        await page.waitForURL(/\/canvas\//, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(3500);
        r.canvasUrl = page.url();
        const body = (await page.textContent("body")) || "";
        r.panelModel = /h3-hybrid-dub-flf/i.test(body);
        r.backPill = await page.locator("a[title^='返回生产页']").count();
        await shot("2-canvas");

        if (r.backPill) {
            await page.locator("a[title^='返回生产页']").first().click();
            await page.waitForURL(/digital-human-book/, { timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(3500);
            r.backUrl = page.url();
            r.backOk = (await page.locator("[data-node-id='wf-voice']").count()) > 0;
            // 当前段应为 P01（左栏选中项 aria-pressed）
            const pressed = await page.$$eval("button[aria-pressed='true']", (els) => els.map((e) => e.textContent || ""));
            r.selectedSegText = pressed.map((t) => t.slice(0, 12));
            await shot("3-back");
        }
    }
    r.errors = errors.slice(0, 4);
    console.log(JSON.stringify(r, null, 2));
    await browser.close();
})();
