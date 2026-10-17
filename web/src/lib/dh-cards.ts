import type { SegmentCard } from "@/services/digital-human-doc";

// 信息卡渲染合同：合成时用 Canvas 渲成透明 PNG（服务端 overlay 层叠上），中栏预览用
// 同一套相对布局参数画 DOM——所有尺寸均为相对画幅宽 W 的比例，保证预览所见 = 成片所得。

export const CARD_STYLE = {
    /** 卡片左上角锚点（相对画幅） */
    anchorX: 0.07,
    anchorY: 0.1,
    maxWidth: 0.64,
    padX: 0.03,
    padY: 0.024,
    radius: 0.026,
    /** 左侧金色竖条宽 */
    barWidth: 0.009,
    titleSize: 0.058,
    lineSize: 0.034,
    /** 行距 / 标题与正文间距 */
    lineGap: 0.016,
    titleGap: 0.018,
    bg: "rgba(10,12,18,0.74)",
    accent: "#F5C86B",
    white: "#ffffff",
    whiteDim: "rgba(255,255,255,0.88)",
    fontFamily: '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif',
} as const;

/** 卡片矩形（相对画幅，左上角锚点） */
export type CardBox = { x: number; y: number; w: number; h: number };

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, w, h, r);
        return;
    }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/**
 * 在全幅（W×H）canvas 上绘制信息卡：深色圆角底 + 金色竖条 + 白色标题 +
 * 金色强调词（带下划线）+ 附加行。返回卡片矩形（相对画幅）。
 */
export function drawCardOnCanvas(canvas: HTMLCanvasElement, card: SegmentCard, width: number, height: number): CardBox {
    const ctx = canvas.getContext("2d");
    if (!ctx) return { x: CARD_STYLE.anchorX, y: CARD_STYLE.anchorY, w: 0, h: 0 };
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    const lines = card.lines ?? [];
    const titleFont = `bold ${Math.round(CARD_STYLE.titleSize * width)}px ${CARD_STYLE.fontFamily}`;
    const lineFont = `${Math.round(CARD_STYLE.lineSize * width)}px ${CARD_STYLE.fontFamily}`;
    const textOf = (text: string, font: string) => {
        ctx.font = font;
        return ctx.measureText(text).width;
    };
    // 内容过宽时等比缩小字号（信息卡是短文案，通常不触发）
    const availW = CARD_STYLE.maxWidth * width - CARD_STYLE.padX * 2 * width - CARD_STYLE.barWidth * width;
    const rawContentW = Math.max(
        textOf(card.title, titleFont),
        card.highlight ? textOf(card.highlight, titleFont) : 0,
        ...lines.map((l) => textOf(l.text, lineFont)),
    );
    const scale = rawContentW > availW ? availW / rawContentW : 1;
    const titlePx = Math.round(CARD_STYLE.titleSize * width * scale);
    const linePx = Math.round(CARD_STYLE.lineSize * width * scale);
    const titleFontScaled = `bold ${titlePx}px ${CARD_STYLE.fontFamily}`;
    const lineFontScaled = `${linePx}px ${CARD_STYLE.fontFamily}`;

    const contentW = Math.max(
        textOf(card.title, titleFontScaled),
        card.highlight ? textOf(card.highlight, titleFontScaled) : 0,
        ...lines.map((l) => textOf(l.text, lineFontScaled)),
    );
    const padX = CARD_STYLE.padX * width;
    const padY = CARD_STYLE.padY * width;
    const barW = CARD_STYLE.barWidth * width;
    const gapTitle = CARD_STYLE.titleGap * width;
    const gapLine = CARD_STYLE.lineGap * width;
    const titleH = titlePx * 1.25;
    const lineH = linePx * 1.35;
    const underlineH = card.highlight ? Math.max(2, titlePx * 0.1) : 0;
    let contentH = titleH;
    if (card.highlight) contentH += gapTitle + titleH * 0.92 + underlineH;
    contentH += lines.length ? gapTitle + lines.length * (lineH + gapLine) - gapLine : 0;

    const box: CardBox = {
        x: CARD_STYLE.anchorX,
        y: CARD_STYLE.anchorY,
        w: contentW + padX * 2 + barW,
        h: contentH + padY * 2,
    };

    // 底板 + 左侧金色竖条
    ctx.fillStyle = CARD_STYLE.bg;
    roundRectPath(ctx, box.x * width, box.y * height, box.w, box.h, CARD_STYLE.radius * width);
    ctx.fill();
    ctx.fillStyle = CARD_STYLE.accent;
    roundRectPath(ctx, box.x * width, box.y * height + CARD_STYLE.radius * width * 0.6, barW, box.h - CARD_STYLE.radius * width * 1.2, barW / 2);
    ctx.fill();

    let cy = box.y * height + padY;
    const cx = box.x * width + barW + padX;
    ctx.textBaseline = "top";
    // 标题（白）
    ctx.font = titleFontScaled;
    ctx.fillStyle = CARD_STYLE.white;
    ctx.fillText(card.title, cx, cy);
    cy += titleH;
    // 强调词（金色 + 下划线）
    if (card.highlight) {
        cy += gapTitle;
        ctx.font = titleFontScaled;
        ctx.fillStyle = CARD_STYLE.accent;
        const hy = cy + titleH * 0.92;
        ctx.fillText(card.highlight, cx, cy);
        ctx.fillRect(cx, hy, Math.min(contentW, textOf(card.highlight, titleFontScaled)), underlineH);
        cy = hy + underlineH;
    }
    // 附加行
    if (lines.length) {
        cy += gapTitle;
        for (const line of lines) {
            ctx.font = lineFontScaled;
            ctx.fillStyle = line.gold ? CARD_STYLE.accent : CARD_STYLE.whiteDim;
            ctx.fillText(line.text, cx, cy);
            cy += lineH + gapLine;
        }
    }
    return box;
}

/** 渲染单张信息卡为透明 PNG（裁剪到卡片矩形），返回 blob 与相对画幅定位 */
export async function renderCardPng(card: SegmentCard, geo: { width: number; height: number }): Promise<{ blob: Blob; box: CardBox }> {
    const full = document.createElement("canvas");
    const box = drawCardOnCanvas(full, card, geo.width, geo.height);
    const cropped = document.createElement("canvas");
    const x = Math.max(0, Math.floor(box.x * geo.width));
    const y = Math.max(0, Math.floor(box.y * geo.height));
    const w = Math.min(geo.width - x, Math.ceil(box.w));
    const h = Math.min(geo.height - y, Math.ceil(box.h));
    cropped.width = w;
    cropped.height = h;
    const ctx = cropped.getContext("2d");
    if (ctx) ctx.drawImage(full, x, y, w, h, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => cropped.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("信息卡渲染失败");
    return { blob, box };
}
