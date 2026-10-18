const { chromium } = require("playwright");
const BOOK = "digitalhuman-paper-001";
(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1680, height: 1020 } });
    await page.goto(`http://127.0.0.1:3000/digital-human-book/${BOOK}`, { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForTimeout(3000);
    const actions = page.locator(".first-creation-actions button");
    if (await actions.count()) { await actions.first().click({ force: true }).catch(() => undefined); await page.waitForTimeout(800); }
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: "../.local/verify-converge2.png" });
    console.log("done");
    await browser.close();
})();
