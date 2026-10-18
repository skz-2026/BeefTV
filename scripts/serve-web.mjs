// 生产静态服务器：给手机远程访问用。
// 相比 `vite preview`，这里补了三件对远端加载影响最大的事：
// 1. text 资源 gzip（Vite preview 不压缩，一个 chunk 就是 1.8MB）；
// 2. /static/* 长缓存（构建产物带内容哈希，重复打开不再重下）；
// 3. /api 反向代理到 owner 代理，SSE 通过 pipe 流式透传，不做缓冲。
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { createGzip, gzipSync } from "node:zlib";

const root = resolve(process.env.WEB_DIST || join(process.cwd(), "dist"));
const port = Number(process.env.PORT || 3000);
const apiTarget = new URL(process.env.API_TARGET || "http://127.0.0.1:8090");
const indexPath = join(root, "index.html");

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".wasm": "application/wasm",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
};
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".webmanifest", ".svg", ".map", ".txt"]);
const gzipCache = new Map();

function proxy(req, res) {
    const headers = { ...req.headers, host: apiTarget.host };
    headers["x-forwarded-host"] = req.headers["x-forwarded-host"] || req.headers.host || "";
    headers["x-forwarded-proto"] = req.headers["x-forwarded-proto"] || "http";
    headers["x-forwarded-for"] = req.socket.remoteAddress || "";
    const upstream = httpRequest(
        { hostname: apiTarget.hostname, port: apiTarget.port || 80, path: req.url, method: req.method, headers },
        (response) => {
            const contentType = String(response.headers["content-type"] || "");
            const status = response.statusCode || 502;
            const canGzipJson = req.method !== "HEAD" && status !== 204 && status !== 304 && contentType.startsWith("application/json") && /\bgzip\b/.test(req.headers["accept-encoding"] || "");
            if (canGzipJson) {
                const headers = { ...response.headers };
                delete headers["content-length"];
                headers["content-encoding"] = "gzip";
                headers["vary"] = "accept-encoding";
                res.writeHead(status, headers);
                response.pipe(createGzip()).pipe(res);
                return;
            }
            res.writeHead(status, response.headers);
            response.pipe(res);
        },
    );
    upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ code: 502, data: null, msg: "后端不可用" }));
    });
    req.pipe(upstream);
}

function sendFile(req, res, filePath) {
    let stat;
    try {
        stat = statSync(filePath);
    } catch {
        return false;
    }
    const ext = extname(filePath).toLowerCase();
    const headers = {
        "content-type": MIME[ext] || "application/octet-stream",
        "cache-control": filePath.startsWith(join(root, "static") + sep) ? "public, max-age=31536000, immutable" : "no-cache",
        "last-modified": stat.mtime.toUTCString(),
    };
    const acceptsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
    if (acceptsGzip && COMPRESSIBLE.has(ext) && stat.size > 1024) {
        let cached = gzipCache.get(filePath);
        if (!cached || cached.mtimeMs !== stat.mtimeMs) {
            cached = { mtimeMs: stat.mtimeMs, body: gzipSync(readFileSync(filePath)) };
            gzipCache.set(filePath, cached);
        }
        headers["content-encoding"] = "gzip";
        headers["vary"] = "accept-encoding";
        headers["content-length"] = cached.body.length;
        res.writeHead(200, headers);
        res.end(cached.body);
        return true;
    }
    headers["content-length"] = stat.size;
    res.writeHead(200, headers);
    createReadStream(filePath).pipe(res);
    return true;
}

const server = createServer((req, res) => {
    if ((req.url || "").startsWith("/api/")) {
        proxy(req, res);
        return;
    }
    let pathname = "/";
    try {
        pathname = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
    } catch {
        res.writeHead(400).end("bad request");
        return;
    }
    const resolved = resolve(root, "." + pathname);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
        res.writeHead(403).end("forbidden");
        return;
    }
    try {
        const stat = statSync(resolved);
        if (stat.isFile() && sendFile(req, res, resolved)) return;
    } catch {
        // 目录或不存在的路径统一走 SPA 回退。
    }
    // 静态文件不存在时回退到 SPA：带扩展名的按资源 404，其余（包括 `/remote`）交给前端路由。
    const lastSegment = pathname.split("/").pop() || "";
    const looksLikeAsset = lastSegment.includes(".");
    const wantsHtml = String(req.headers.accept || "").includes("text/html");
    if ((req.method === "GET" || req.method === "HEAD") && (!looksLikeAsset || wantsHtml)) {
        if (sendFile(req, res, indexPath)) return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
});

server.listen(port, "0.0.0.0", () => {
    process.stdout.write(`[web] http://0.0.0.0:${port}  dist=${root}  api=${apiTarget.origin}\n`);
});
