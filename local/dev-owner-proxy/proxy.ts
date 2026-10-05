// 本机可信代理：在 /api 请求上注入 owner 凭据头，让浏览器 UI 获得
// 「受信任本机前端」身份（canvas.document.commit 等写操作需要）。
//
// 背景：cmd/server（ProfileServer）没有桌面启动令牌，浏览器直连时
// /api/ops 写操作全部 403，画布文档只存本地草稿，生成结果无法回填节点。
// 官方 dev 流程用 wails dev（桌面形态）；本代理让 server 形态达到同等效果。
//
// 用法：node proxy.js  （默认 8090 -> 8080，令牌从数据目录读取）
// 然后 Vite 用 VITE_API_PROXY_TARGET=http://127.0.0.1:8090 启动。
import { createServer, type IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

const UPSTREAM_HOST = process.env.OWNER_PROXY_UPSTREAM_HOST || "127.0.0.1";
const UPSTREAM_PORT = Number(process.env.OWNER_PROXY_UPSTREAM_PORT || 8080);
const PORT = Number(process.env.OWNER_PROXY_PORT || 8090);
const TOKEN_PATH = process.env.OWNER_PROXY_TOKEN_FILE
    || "C:/work/BeefTV/.local/project-workbench-debug/agent_owner_token";

const ownerToken = readFileSync(TOKEN_PATH, "utf8").trim();

function log(message: string) {
    process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${message}\n`);
}

const server = createServer((req: IncomingMessage, res) => {
    const headers = { ...req.headers, "x-beeftv-owner": ownerToken };
    delete headers.host;
    delete headers["content-length"];
    const upstream = fetch(`http://${UPSTREAM_HOST}:${UPSTREAM_PORT}${req.url}`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
        // @ts-expect-error Node 专用流式选项
        duplex: "half",
    });

    upstream.then(async (upstreamRes) => {
        const headersOut: Record<string, string> = {};
        upstreamRes.headers.forEach((value, key) => {
            if (key !== "transfer-encoding" && key !== "content-encoding") headersOut[key] = value;
        });
        res.writeHead(upstreamRes.status, headersOut);
        const reader = upstreamRes.body?.getReader();
        if (!reader) return res.end();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
        }
        res.end();
    }).catch((error) => {
        log(`转发失败 ${req.method} ${req.url}: ${error.message}`);
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 502, data: null, msg: "owner proxy upstream error" }));
    });
});

server.listen(PORT, "127.0.0.1", () => {
    log(`owner 代理已启动：http://127.0.0.1:${PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}（已注入 X-Beeftv-Owner）`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
