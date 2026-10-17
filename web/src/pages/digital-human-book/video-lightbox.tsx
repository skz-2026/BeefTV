import { useEffect } from "react";

// 视频全屏预览：Esc / 点击背景关闭；黑底居中，最大化看片用。
export function VideoLightbox({ src, onClose }: { src: string | null; onClose: () => void }) {
    useEffect(() => {
        if (!src) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [src, onClose]);
    if (!src) return null;
    return (
        <div
            role="dialog"
            aria-label="视频全屏预览"
            onClick={onClose}
            style={{ position: "fixed", inset: 0, zIndex: 1200, background: "rgba(0,0,0,.9)", display: "grid", placeItems: "center", padding: 24 }}
        >
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
                src={src}
                controls
                autoPlay
                onClick={(e) => e.stopPropagation()}
                style={{ maxWidth: "94vw", maxHeight: "90vh", borderRadius: 12, background: "#000" }}
            />
            <button
                type="button"
                aria-label="关闭预览"
                onClick={onClose}
                style={{ position: "absolute", top: 18, right: 22, border: "none", background: "rgba(255,255,255,.14)", color: "#fff", fontSize: 20, width: 40, height: 40, borderRadius: "50%", cursor: "pointer" }}
            >×</button>
        </div>
    );
}
