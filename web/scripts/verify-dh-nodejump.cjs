// 验证：右栏点节点 → 跳原生画布 → 选中该节点并弹生成面板（点节点弹参数面板的统一体验）。
const { chromium } = require("playwright");
const BOOK = "digitalhuman-paper-001";
(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1680, height: 1020 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 140)}`); });
    const report = {};

    await page.goto(`http://127.0.0.1:3000/digital-human-book/${BOOK}`, { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForTimeout(3000);
    const actions = page.locator(".first-creation-actions button");
    if (await actions.count()) { await actions.first().click({ force: true }).catch(() => undefined); await page.waitForTimeout(600); }
    await page.waitForTimeout(2000);

    // 点右栏「站位首帧」节点（wf-frame）→ 应跳转原生画布并弹 qwen-edit-plus 生成面板
    const frame = page.locator("[data-node-id='wf-frame']").first();
    report.rightPaneHasFrame = await frame.count() > 0;
    if (await frame.count()) {
        await frame.click({ force: true });
        await page.waitForURL(/\/canvas\//, { timeout: 15000 }).catch(() => undefined);
        await page.waitForTimeout(3000);
        report.urlAfterClick = page.url();
        report.atCanvas = /\/canvas\//.test(page.url());
        const body = (await page.textContent("body")) || "";
        report.panelMentionsEditModel = /qwen-edit/i.test(body);
        report.panelOpen = /生成设置|提示词|生成/.test(body);
        await page.screenshot({ path: "../.local/verify-nodejump.png" });
    }
    report.errors = errors.slice(0, 5);
    console.log(JSON.stringify(report, null, 2));
    await browser.close();
})();
