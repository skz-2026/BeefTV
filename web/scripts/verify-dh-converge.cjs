// 验证右栏收敛：渲染的是段画布真文档节点（wf-voice），派生节点（wf-audio）不再出现；
// 点击配音节点 = 播放/生成（quickAction 正常），无 console 报错。
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
    for (const label of ["稍后", "跳过", "知道了", "关闭"]) {
        const btn = page.getByRole("button", { name: label });
        if (await btn.count()) { await btn.first().click({ force: true }).catch(() => undefined); await page.waitForTimeout(300); }
    }
    await page.waitForTimeout(2000);
    // 右栏画布节点 id（画布 scope = segment）
    report.nodeIds = await page.$$eval("[data-node-id]", (els) => els.map((e) => e.getAttribute("data-node-id")));
    report.hasRealVoiceNode = report.nodeIds.includes("wf-voice");
    report.hasLegacyDerivedAudioNode = report.nodeIds.includes("wf-audio");
    report.hasExportNode = report.nodeIds.includes("wf-export");
    report.hintText = ((await page.textContent("body")) || "").includes("与画布库是同一份画布");
    await page.screenshot({ path: "../.local/verify-converge.png" });
    // 点配音节点：音频已就绪 → 应回收为试听（出现 audio 播放，不报错）
    const voice = page.locator("[data-node-id='wf-voice']");
    if (await voice.count()) {
        await voice.first().click({ force: true });
        await page.waitForTimeout(1200);
        report.voiceClicked = true;
    }
    report.errors = errors.slice(0, 5);
    console.log(JSON.stringify(report, null, 2));
    await browser.close();
})();
