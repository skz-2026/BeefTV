// 真机验证：生产页 + 画布库里的段画布，确认
// 1) 段画布真的是一张"生产台"：节点带 ①②③ 链路标注、连线表达参考关系
// 2) 首帧节点预填 qwen-edit-plus、配音节点带音色+台词、段视频节点带 dub-flf 契约
// 3) 信息卡是可编辑文本且不进提示词
// 4) 点节点能打开生成面板（画布可二次编辑）
// 5) 段画布文档结构（连线/契约字段）与预期一致——直接查库，避免 DOM 选择器漂移
const { chromium } = require("playwright");

const BOOK = "digitalhuman-paper-001";
const SEG = "P01";
const BASE = "http://127.0.0.1:3000";
const API = "http://127.0.0.1:8080/api";

/** 取节点标题：优先 class 含 title 的元素，其次节点自身 innerText 首行 */
function nodeTitles(page) {
    return page.$$eval("[data-node-id]", (els) =>
        els.map((el) => {
            const t = el.querySelector("[class*='title'], header, h1, h2, h3");
            const text = (t ? t.textContent : el.innerText || el.getAttribute("title") || "")
                .split("\n")[0]
                .trim();
            return { id: el.getAttribute("data-node-id"), title: text.slice(0, 60) };
        }).filter((row) => row.id),
    ).catch(() => []);
}

async function segDoc() {
    const res = await fetch(`${API}/canvas-projects/${encodeURIComponent(`${BOOK}__${SEG}`)}`);
    if (!res.ok) return { error: res.status };
    const { data } = await res.json();
    const project = data.project;
    const byId = Object.fromEntries((project.nodes || []).map((n) => [n.id, n]));
    return {
        revision: project.revision,
        nodes: (project.nodes || []).map((n) => `${n.id}:${n.type}`),
        connections: (project.connections || []).map((c) => `${c.fromNodeId}->${c.toNodeId}`),
        layout: byId["dh-note"]?.metadata?.dhLayout,
        frame: {
            model: byId["wf-frame"]?.metadata?.model,
            storageKey: byId["wf-frame"]?.metadata?.storageKey,
            dhPull: byId["wf-frame"]?.metadata?.dhPull,
            operation: byId["wf-frame"]?.metadata?.promptTemplateOperation,
        },
        clip: {
            model: byId[`seg-${SEG}`]?.metadata?.model,
            template: byId[`seg-${SEG}`]?.metadata?.dhVideoTemplate,
            frameSource: byId[`seg-${SEG}`]?.metadata?.dhFrameSourceNodeId,
            videoResourceId: byId[`seg-${SEG}`]?.metadata?.videoResourceId,
        },
        cards: {
            title: byId["wf-cards"]?.title,
            content: byId["wf-cards"]?.metadata?.content,
            overlay: byId["wf-cards"]?.metadata?.dhOverlayText,
        },
        voice: {
            title: byId["wf-voice"]?.title,
            audioVoice: byId["wf-voice"]?.metadata?.audioVoice,
            durationMs: byId["wf-voice"]?.metadata?.durationMs,
        },
    };
}

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1680, height: 1020 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 140)}`); });

    const report = {};

    const dismiss = async () => {
        for (const label of ["稍后", "跳过", "知道了", "关闭"]) {
            const btn = page.getByRole("button", { name: label });
            if (await btn.count()) { await btn.first().click({ force: true }).catch(() => undefined); await page.waitForTimeout(400); }
        }
        await page.keyboard.press("Escape").catch(() => undefined);
        await page.waitForTimeout(400);
    };

    // ---------- 生产页（加载时会回收段画布产物） ----------
    await page.goto(`${BASE}/digital-human-book/${BOOK}`, { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForTimeout(2500);
    await dismiss();
    await page.waitForTimeout(1200);
    report.productionBadges = ((await page.textContent("body")) || "").match(/[①②③]/g)?.length ?? 0;
    await page.screenshot({ path: "../.local/verify-production.png", fullPage: false });

    // ---------- 画布库：段画布 ----------
    await page.goto(`${BASE}/canvas/${BOOK}__${SEG}`, { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForTimeout(3500);
    await dismiss();
    await page.waitForTimeout(1500);
    report.segTitles = await nodeTitles(page);
    await page.screenshot({ path: "../.local/verify-seg-canvas.png", fullPage: false });

    // 点首帧节点 → 生成面板预填 qwen-edit-plus
    const frameNode = page.locator("[data-node-id='wf-frame']");
    if (await frameNode.count()) {
        await frameNode.first().click({ force: true });
        await page.waitForTimeout(1200);
        const body = (await page.textContent("body")) || "";
        report.framePanelOpened = /生成设置|提示词|生成/.test(body);
        report.framePanelMentionsEditModel = /qwen-edit/i.test(body);
        await page.screenshot({ path: "../.local/verify-frame-panel.png" });
    }

    // 点配音节点 → 面板带音色 + 台词
    const voiceNode = page.locator("[data-node-id='wf-voice']");
    if (await voiceNode.count()) {
        await page.keyboard.press("Escape").catch(() => undefined);
        await voiceNode.first().click({ force: true });
        await page.waitForTimeout(1200);
        const body = (await page.textContent("body")) || "";
        report.voicePanelMentionsVoice = /xiaozhi|小智|indextts/i.test(body);
        report.voicePanelMentionsLine = /两千年前|问你个问题/.test(body);
        await page.screenshot({ path: "../.local/verify-voice-panel.png" });
    }

    // 点段视频节点 → 面板应带 dub-flf 模型
    const clipNode = page.locator(`[data-node-id='seg-${SEG}']`);
    if (await clipNode.count()) {
        await page.keyboard.press("Escape").catch(() => undefined);
        await clipNode.first().click({ force: true });
        await page.waitForTimeout(1400);
        const body = (await page.textContent("body")) || "";
        report.clipPanelMentionsModel = /h3-hybrid-dub-flf|dub-flf/i.test(body);
        await page.screenshot({ path: "../.local/verify-clip-panel.png" });
    }

    report.segDoc = await segDoc();
    report.errors = errors.slice(0, 6);
    console.log(JSON.stringify(report, null, 2));
    await browser.close();
})();
