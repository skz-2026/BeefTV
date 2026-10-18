// 验证步骤条收敛：
// ①台词 → 画布 + 文本编辑器；③场景首帧 → 画布 + qwen-edit 面板；⑤合成 → 抽屉；
// 右栏没有"整册画布"切换；"参数"下拉能开台词语气/音色等段级参数。
const { chromium } = require("playwright");
const BOOK = "digitalhuman-paper-001";
const r = {};

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 140)}`); });

    const enterBook = async () => {
        await page.goto(`http://127.0.0.1:3000/digital-human-book/${BOOK}`, { waitUntil: "networkidle", timeout: 90000 });
        await page.waitForTimeout(2500);
        const guide = page.locator(".first-creation-actions button");
        if (await guide.count()) { await guide.first().click({ force: true }).catch(() => {}); await page.waitForTimeout(600); }
        await page.waitForTimeout(2000);
    };

    await enterBook();
    r.hasScopeSwitcher = (await page.locator(".ant-segmented").count()) > 0;
    r.stepLabels = await page.$$eval("[aria-label='制作进度'] button", (els) => els.map((e) => (e.textContent || "").trim()));

    // ① 台词 → 画布 + 文本编辑器
    await page.locator("[aria-label='制作进度'] button").nth(0).click({ force: true });
    await page.waitForURL(/\/canvas\//, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(4000);
    r.step1Url = page.url();
    // 台词节点打开的是富文本编辑器（contenteditable），不是 textarea
    r.step1TextEditor = (await page.locator("[contenteditable='true']").count()) > 0;
    r.step1EditorHasLine = ((await page.textContent("body")) || "").includes("两千年前");
    await page.screenshot({ path: "../.local/steps-1-script.png" });

    // ② 配音 → 画布 + 音频节点面板
    await enterBook();
    await page.locator("[aria-label='制作进度'] button").nth(1).click({ force: true });
    await page.waitForURL(/\/canvas\//, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const body2 = (await page.textContent("body")) || "";
    r.step2Url = page.url();
    r.step2VoicePanel = /indextts2|音色|xiaozhi/i.test(body2);
    await page.screenshot({ path: "../.local/steps-2-voice.png" });

    // ③ 场景首帧 → 画布 + 生成面板
    await enterBook();
    await page.locator("[aria-label='制作进度'] button").nth(2).click({ force: true });    await page.waitForURL(/\/canvas\//, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const body3 = (await page.textContent("body")) || "";
    r.step3Url = page.url();
    r.step3EditModel = /qwen-edit/i.test(body3);
    await page.screenshot({ path: "../.local/steps-3-frame.png" });

    // ⑤ 合成 → 抽屉
    await enterBook();
    await page.locator("[aria-label='制作进度'] button").nth(4).click({ force: true });
    await page.waitForTimeout(1500);
    r.step5Drawer = (await page.locator(".ant-drawer").count()) > 0;
    r.step5StillOnBook = /digital-human-book/.test(page.url());
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(600);

    // 右栏「参数」下拉
    await page.locator("button", { hasText: "参数" }).last().click({ force: true }).catch(() => {});
    await page.waitForTimeout(800);
    r.paramMenuItems = await page.$$eval(".ant-dropdown-menu-item", (els) => els.map((e) => (e.textContent || "").trim()));
    await page.screenshot({ path: "../.local/steps-4-param.png" });
    if (r.paramMenuItems.length) {
        await page.locator(".ant-dropdown-menu-item").nth(1).click({ force: true });
        await page.waitForTimeout(1200);
        r.paramDrawerOpened = (await page.locator(".ant-drawer").count()) > 0;
        r.paramDrawerHasVoice = (await page.textContent("body") || "").includes("音色");
        await page.keyboard.press("Escape").catch(() => {});
    }

    r.errors = errors.slice(0, 5);
    console.log(JSON.stringify(r, null, 2));
    await browser.close();
})();
