import { useEffect, useRef, useState } from "react";
import { CARD_STYLE } from "@/lib/dh-cards";
import type { SegmentCard } from "@/services/digital-human-doc";

// 信息卡预览层：叠在中栏段视频上，按配音时长均分轮播。布局参数与成片渲染
// （lib/dh-cards 的 Canvas）同一套，按容器实测宽度换算像素——预览所见 = 成片所得。

export function CardPreviewOverlay({ cards, windowMs }: { cards: SegmentCard[]; windowMs: number }) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const [width, setWidth] = useState(0);
    const [index, setIndex] = useState(0);

    useEffect(() => {
        const host = hostRef.current?.parentElement;
        if (!host) return;
        const video = host.querySelector("video");
        const measure = () => setWidth(host.clientWidth);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(host);
        const onTime = () => {
            const t = (video?.currentTime ?? 0) * 1000;
            const i = Math.floor((t - 300) / Math.max(300, windowMs));
            setIndex(Math.max(0, Math.min(cards.length - 1, i)));
        };
        onTime();
        video?.addEventListener("timeupdate", onTime);
        return () => {
            observer.disconnect();
            video?.removeEventListener("timeupdate", onTime);
        };
    }, [cards.length, windowMs]);

    if (!cards.length) return null;
    const card = cards[Math.min(index, cards.length - 1)];
    // 容器必须常驻（width=0 时也要挂载），否则 ResizeObserver 永远不会启动
    const px = (v: number) => `${Math.round(v * width)}px`;
    return (
        <div ref={hostRef} aria-label="信息卡预览" style={{ position: "absolute", left: px(CARD_STYLE.anchorX), top: `${CARD_STYLE.anchorY * 100}%`, maxWidth: px(CARD_STYLE.maxWidth + CARD_STYLE.padX * 2 + CARD_STYLE.barWidth), zIndex: 4, pointerEvents: "none" }}>
            {width && card ? (
                <>
                    <div style={{ position: "relative", background: CARD_STYLE.bg, borderRadius: px(CARD_STYLE.radius), padding: `${px(CARD_STYLE.padY)} ${px(CARD_STYLE.padX)} ${px(CARD_STYLE.padY)} ${px(CARD_STYLE.padX + CARD_STYLE.barWidth)}`, display: "inline-block", boxShadow: "0 8px 30px rgba(0,0,0,.35)" }}>
                        <span aria-hidden style={{ position: "absolute", left: 0, top: px(CARD_STYLE.radius * 0.6), bottom: px(CARD_STYLE.radius * 0.6), width: px(CARD_STYLE.barWidth), background: CARD_STYLE.accent, borderRadius: px(CARD_STYLE.barWidth / 2) }} />
                        {card.title.trim() ? (
                            <div style={{ color: CARD_STYLE.white, fontWeight: 700, fontSize: px(CARD_STYLE.titleSize), lineHeight: 1.25 }}>{card.title}</div>
                        ) : null}
                        {card.highlight ? (
                            <div style={{ marginTop: px(CARD_STYLE.titleGap) }}>
                                <span style={{ color: CARD_STYLE.accent, fontWeight: 700, fontSize: px(CARD_STYLE.titleSize), lineHeight: 1.15, borderBottom: `${Math.max(2, Math.round(CARD_STYLE.titleSize * width * 0.1))}px solid ${CARD_STYLE.accent}` }}>{card.highlight}</span>
                            </div>
                        ) : null}
                        {(card.lines ?? []).length ? (
                            <div style={{ marginTop: px(CARD_STYLE.titleGap), display: "flex", flexDirection: "column", gap: px(CARD_STYLE.lineGap) }}>
                                {(card.lines ?? []).map((l, i) => (
                                    <span key={i} style={{ color: l.gold ? CARD_STYLE.accent : CARD_STYLE.whiteDim, fontSize: px(CARD_STYLE.lineSize), lineHeight: 1.35 }}>{l.text}</span>
                                ))}
                            </div>
                        ) : null}
                    </div>
                    <div style={{ marginTop: 6, fontSize: 11, opacity: 0.55 }}>信息卡 {index + 1}/{cards.length} · 播放时轮播（合成时叠加进成片）</div>
                </>
            ) : null}
        </div>
    );
}
