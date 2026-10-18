// 全链路走查：生产页 → 右栏点节点 → 画布弹面板 → 返回生产页（定位同段）→ 步骤条抽屉 → 整册画布
const { chromium } = require("playwright");
const BOOK = "digitalhuman-paper-001";
const OUT = "../.local/ux";
(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 120)}`); });
    const r = {};
    const shot = (n) => page.screenshot({ path: `${OUT}-${n}.png` });

    // 1) 生产页
    await page.goto(`http://127.0.0.1:3000/digital-human-book/${BOOK}`, { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForTimeout(2500);
    const guide = page.locator(".first-creation-actions button");
    if (await guide.count()) { await guide.first().click({ force: true }).catch(() => {}); await page.waitForTimeout(600); }
    await page.waitForTimeout(2000);
    r.stepBar = await page.locator("[aria-label='制作进度'] button").count();
    r.rightNodes = (await page.$$eval("[data-node-id]", (els) => els.map((e) => e.getAttribute("data-node-id")))).filter((v, i, a) => a.indexOf(v) === i);
    r.hintPresent = ((await page.textContent("body")) || "").includes("只读总览");
    await shot("1-production");

    // 2) 点右栏段视频节点 → 画布 + 面板 + 返回入口
    const segNode = page.locator("[data-node-id='seg-P01']").first();
    r.segNodeFound = await segNode.count() > 0;
    if (r.segNodeFound) {
        await segNode.click({ force: true });
        await page.waitForURL(/\/canvas\//, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(3500);
        r.canvasUrl = page.url();
        const body = (await page.textContent("body")) || "";
        r.panelModelOnCanvas = /h3-hybrid-dub-flf/i.test(body);
        r.backPill = await page.locator("a[title^='返回生产页']").count();
        await shot("2-canvas-panel");

        // 3) 返回生产页
        if (r.backPill) {
            await page.locator("a[title^='返回生产页']").first().click();
            await page.waitForURL(/digital-human-book/, { timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(3000);
            r.backUrl = page.url();
            r.backAtProduction = /digital-human-book/.test(page.url());
            // 回来自动收画布产物 + 当前段仍是 P01
            r.segStillP01 = /P01/.test((await page.textContent("[aria-label='制作进度']") || "")) ;
            r.backLoadedOk = (await page.locator("[data-node-id='wf-voice']").count()) > 0;
            await shot("3-back");
        }
    }

    // 4) 步骤条 → 抽屉
    const steps = page.locator("[aria-label='制作进度'] button");
    if (await steps.count()) {
        await steps.nth(1).click({ force: true });
        await page.waitForTimeout(1200);
        r.drawerOpened = (await page.locator(".ant-drawer").count()) > 0;
        await shot("4-drawer");
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(600);
    }

    // 5) 整册画布 scope
    const segmented = page.locator(".ant-segmented-item-label", { hasText: "整册画布" });
    if (await segmented.count()) {
        await segmented.first().click({ force: true });
        await page.waitForTimeout(1500);
        r.overviewNodes = (await page.$$eval("[data-node-id]", (els) => els.map((e) => e.getAttribute("data-node-id")))).length;
        await shot("5-overview");
        await page.locator(".ant-segmented-item-label", { hasText: "本段流程" }).first().click({ force: true });
        await page.waitForTimeout(800);
    }

    r.errors = errors.slice(0, 5);
    console.log(JSON.stringify(r, null, 2));
    await browser.close();
})();
