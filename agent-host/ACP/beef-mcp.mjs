#!/usr/bin/env node
// BeefTV 的 MCP stdio 桥：由 ACP agent 按 session/new.mcpServers 拉起。
// 只把工具目录/调用转发回宿主的本机回环端点；不接触 Go 的宿主 token，也不读写文件。
import process from 'node:process';

const CALLBACK = String(process.env.BEEFTV_ACP_CALLBACK || '').replace(/\/+$/, '');
const TOKEN = String(process.env.BEEFTV_ACP_TOKEN || '');
const PROTOCOL_VERSION = '2025-06-18';

if (!CALLBACK || !TOKEN) {
  process.stderr.write('beef-mcp: 缺少 BEEFTV_ACP_CALLBACK 或 BEEFTV_ACP_TOKEN\n');
  process.exit(2);
}

async function callHost(method, params = {}) {
  const response = await fetch(CALLBACK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ method, ...params }),
    // 媒体工具最慢约 95s；给桥留出余量，避免 agent 无限等一个死连接。
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`宿主返回了非 JSON（${response.status}）：${text.slice(0, 200)}`);
  }
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.error || `宿主调用失败（${response.status}）`);
  }
  return body.result;
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'beeftv', version: '0.1.0' },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') {
    if (isRequest) reply(id, {});
    return;
  }
  if (method === 'tools/list') {
    try {
      const tools = await callHost('list');
      reply(id, { tools: tools || [] });
    } catch (error) {
      replyError(id, -32603, String(error?.message || error));
    }
    return;
  }
  if (method === 'tools/call') {
    try {
      const result = await callHost('call', {
        name: String(params?.name || ''),
        arguments: params?.arguments && typeof params.arguments === 'object' ? params.arguments : {},
      });
      reply(id, result || { content: [] });
    } catch (error) {
      // 工具失败以 MCP 结果返回，模型能看到原因并决定是否重试。
      reply(id, { content: [{ type: 'text', text: String(error?.message || error) }], isError: true });
    }
    return;
  }
  if (isRequest) replyError(id, -32601, `未知方法：${method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).replace(/\r$/, '').trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write(`beef-mcp: 非 JSON 行：${line.slice(0, 120)}\n`);
      continue;
    }
    handle(message).catch((error) => {
      if (message.id !== undefined) replyError(message.id, -32603, String(error?.message || error));
    });
  }
});
process.stdin.on('end', () => process.exit(0));
