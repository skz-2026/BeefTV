import { dirname, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { resolveHeavyMediaEnabled } from "./media-build-mode";

const webDir = dirname(fileURLToPath(import.meta.url));
const appVersion = process.env.CANVAS_BUILD_VERSION?.trim() || readFileSync(resolve(webDir, "../VERSION"), "utf8").trim();
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET?.trim() || "http://127.0.0.1:8080";
const desktopLaunchToken = process.env.VITE_DESKTOP_LAUNCH_TOKEN?.trim();
const heavyMediaEnabled = resolveHeavyMediaEnabled(process.env.BEEFTV_FULL_MEDIA_RESOURCES);
// Tailscale Serve forwards the tailnet hostname in Host while proxying to 127.0.0.1:3000.
// Vite only accepts localhost and literal IPs by default, so that request is rejected
// before it reaches the dev server. Allow the Tailscale suffix and extend it with
// BEEFTV_ALLOWED_HOSTS (comma separated, "*" opts into any host) for other proxies.
const allowedHosts = resolveAllowedHosts(process.env.BEEFTV_ALLOWED_HOSTS);
// With `tailscale serve` the page is https on 443 while Vite listens on 3000, so the
// HMR socket has to use the proxy port instead of the page port.
const hmrClientPort = Number(process.env.BEEFTV_DEV_HMR_CLIENT_PORT || 0) || undefined;
const apiProxy = {
    "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
        xfwd: true,
        ...(desktopLaunchToken ? { headers: { "X-Desktop-Token": desktopLaunchToken } } : {}),
    },
};

function resolveAllowedHosts(raw: string | undefined): string[] | true {
    if (raw === undefined) return [".ts.net"];
    const configured = raw.split(",").map((value) => value.trim()).filter(Boolean);
    return configured.includes("*") ? true : configured;
}

// 手机链路上每个动态 import 都是一次 300-400ms 的往返。构建完成后把首页要用到的
// chunk 图直接写进 index.html 的 modulepreload，浏览器一次并发拉完，不再逐层发现。
function preloadHomeGraphPlugin() {
    return {
        name: "beeftv-preload-home-graph",
        apply: "build" as const,
        closeBundle() {
            const outDir = resolve(webDir, process.env.BEEFTV_WEB_OUT_DIR?.trim() || "dist");
            const manifestPath = resolve(outDir, ".vite/manifest.json");
            const indexPath = resolve(outDir, "index.html");
            if (!existsSync(manifestPath) || !existsSync(indexPath)) return;
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, { file?: string; imports?: string[] }>;
            const roots = ["index.html", "src/bootstrap-workspace.ts", "src/layouts/user-layout.tsx", "src/pages/home/index.tsx"];
            const files = new Set<string>();
            const seen = new Set<string>();
            const walk = (key: string) => {
                if (seen.has(key)) return;
                seen.add(key);
                const entry = manifest[key];
                if (!entry) return;
                if (entry.file?.endsWith(".js")) files.add(entry.file);
                for (const dependency of entry.imports || []) walk(dependency);
            };
            for (const root of roots) walk(root);
            const html = readFileSync(indexPath, "utf8");
            const links = [...files].filter((file) => !html.includes(`/${file}`)).map((file) => `<link rel="modulepreload" crossorigin href="/${file}">`).join("\n");
            if (links) writeFileSync(indexPath, html.replace("</head>", `${links}\n</head>`));
        },
    };
}

function pruneOptionalMediaPlugin() {
    return {
        name: "beeftv-prune-optional-media",
        closeBundle() {
            const dist = resolve(webDir, "dist");
            // The retired public welcome site is never part of the application.
            rmSync(resolve(dist, "welcome"), { recursive: true, force: true });
            if (heavyMediaEnabled) return;
            for (const directory of ["mediapipe", "lighting-presets", "three"]) {
                rmSync(resolve(dist, directory), { recursive: true, force: true });
            }
            rmSync(resolve(dist, "canvas/models/blaze-face-full-range-sparse.tflite"), { force: true });
            const staticDir = resolve(dist, "static");
            for (const file of readdirSync(staticDir)) {
                if (file.startsWith("ffmpeg-core-")) rmSync(resolve(staticDir, file), { force: true });
            }
        },
    };
}

export default defineConfig({
    plugins: [react(), pruneOptionalMediaPlugin(), preloadHomeGraphPlugin()],
    define: {
        __APP_VERSION__: JSON.stringify(appVersion),
        __BEEFTV_HEAVY_MEDIA_ENABLED__: JSON.stringify(heavyMediaEnabled),
        "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
    },
    server: {
        allowedHosts,
        ...(hmrClientPort ? { hmr: { clientPort: hmrClientPort } } : {}),
        proxy: apiProxy,
    },
    // `bun run start` serves the production build for everyday remote use; it keeps the
    // same API proxy and host allowlist so a tailnet URL behaves like the dev server.
    preview: {
        allowedHosts,
        proxy: apiProxy,
    },
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    build: {
        // Keep the SPA route `/assets` distinct from Vite's emitted static files.
        // Otherwise vite preview treats `/assets` as the physical asset directory
        // and a direct refresh of the asset library can return 404.
        assetsDir: "static",
        outDir: process.env.BEEFTV_WEB_OUT_DIR?.trim() || "dist",
        manifest: true,
        rolldownOptions: {
            output: {
                strictExecutionOrder: true,
                codeSplitting: {
                    // Keep route-level lazy imports isolated. Recursively merging dependencies
                    // pulls unrelated pages into the initial modulepreload graph.
                    includeDependenciesRecursively: false,
                    minSize: 40 * 1024,
                    groups: [
                        {
                            // Shared interop helpers must not be emitted into a route entry:
                            // AntD would import that entry back and execute its bootstrap early.
                            name: "vendor-babel-runtime",
                            minSize: 0,
                            test: /node_modules[\\/]@babel[\\/]runtime[\\/]/,
                            priority: 40,
                        },
                        {
                            name: "vendor-react",
                            test: /node_modules[\\/](?:react(?:-dom|-router|-router-dom)?|scheduler|zustand|use-sync-external-store|@tanstack[\\/](?:query-core|react-query))[\\/]/,
                            priority: 30,
                        },
                        {
                            name: "vendor-icons",
                            test: /node_modules[\\/](?:lucide-react|@ant-design[\\/]icons)[\\/]/,
                            priority: 20,
                            entriesAware: true,
                            entriesAwareMergeThreshold: 48 * 1024,
                        },
                        {
                            name: "vendor-antd",
                            test: /node_modules[\\/](?:antd|@ant-design|@rc-component|rc-[^\\/]+|dayjs)[\\/]/,
                            priority: 10,
                            entriesAware: true,
                            entriesAwareMergeThreshold: 80 * 1024,
                        },
                    ],
                },
            },
        },
    },
});


