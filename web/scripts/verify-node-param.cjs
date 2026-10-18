const { chromium } = require("playwright");
(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1680, height: 1020 } });
    const report = {};
    await page.goto("http://127.0.0.1:3000/canvas/digitalhuman-paper-001__P01?fit=1&node=wf-frame", { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForTimeout(6000);
    const body = (await page.textContent("body")) || "";
    report.mentionsQwenEdit = /qwen-edit/i.test(body);
    report.mentionsPromptPanel = /提示词/.test(body);
    // 面板容器是否存在（CanvasNodePanelOverlay 的子面板）
    report.hasTextarea = await page.locator("textarea").count();
    // 直接对比：手动点一次节点（原生点击路径）
    const node = page.locator("[data-node-id='wf-frame']").first();
    if (await node.count()) {
        await node.click({ force: true });
        await page.waitForTimeout(1500);
        const body2 = (await page.textContent("body")) || "";
        report.afterManualClickQwenEdit = /qwen-edit/i.test(body2);
        report.afterManualClickTextarea = await page.locator("textarea").count();
    }
    await page.screenshot({ path: "../.local/verify-node-param.png" });
    console.log(JSON.stringify(report, null, 2));
    await browser.close();
})();
