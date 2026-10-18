// BeefTV 内置助手的 ACP 宿主：与 pi 宿主实现同一套 HTTP/NDJSON 契约，
// 内部用 Agent Client Protocol 驱动 Codex / ZCode 等外部 agent。
//
// 边界：
// - Go 仍是业务权威：回合、权限、操作回执、撤销全部在 Go；
// - 这里只把 ACP 的流式事件翻译成 BeefTV 面板认识的事件；
// - 工具通过 beeftv MCP 桥回到 Go 的 /api/ops，身份仍是内置助手回合。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';

import { AcpClient } from './acp-client.mjs';
import { SessionStore } from './session-store.mjs';
import { readRuntimeConfig, agentEnvironment, agentWorkspace } from './runtime-config.mjs';
import { createOperationBridge, scopedSchema } from '../operation-bridge.mjs';
import { newTurnAccumulator, resetTurnAccumulator, turnChange, turnContextPrefix } from '../canvas-turn.mjs';
import { createTurnBudget } from '../request-budget.mjs';
import { SYSTEM_PROMPT } from '../system-prompt.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = path.join(HERE, 'beef-mcp.mjs');

const DATA_DIR = process.env.BEEFTV_AGENT_DATA_DIR || '';
const HOST_TOKEN = process.env.BEEFTV_AGENT_HOST_TOKEN || '';
const DESKTOP_TOKEN = process.env.BEEFTV_AGENT_DESKTOP_TOKEN || '';
const OPS_URL = (process.env.BEEFTV_OPS_URL || 'http://127.0.0.1:18090/api').replace(/\/+$/, '');
const ALLOWED_ORIGIN = process.env.BEEFTV_AGENT_ALLOWED_ORIGIN || '';
const LISTEN_FD = Number(process.env.BEEFTV_AGENT_LISTEN_FD || 0);
const PORT = Number(String(process.env.BEEFTV_AGENT_PORT || '').trim() || 0);
const INSTANCE_NONCE = process.env.BEEFTV_AGENT_INSTANCE_NONCE || '';
const LIFETIME_STDIN = process.env.BEEFTV_AGENT_LIFETIME_STDIN === '1';
const RUN_ID = crypto.randomUUID();
const MAX_BODY_BYTES = 1024 * 1024;

if (!DATA_DIR || !HOST_TOKEN) {
  console.error('acp-host: 缺少 BEEFTV_AGENT_DATA_DIR 或 BEEFTV_AGENT_HOST_TOKEN');
  process.exit(2);
}
if (!LISTEN_FD && !PORT) {
  console.error('acp-host: 缺少 BEEFTV_AGENT_PORT 或 BEEFTV_AGENT_LISTEN_FD');
  process.exit(2);
}

const CONFIG = readRuntimeConfig(DATA_DIR);
const store = new SessionStore({ root: path.join(DATA_DIR, 'acp-host') });
const turnBudgetContext = new AsyncLocalStorage();
const ops = createOperationBridge({
  opsUrl: OPS_URL,
  hostToken: HOST_TOKEN,
  desktopToken: DESKTOP_TOKEN,
  readOnly: false,
  turnBudgetContext,
  mediaModel: { api: 'acp', modelId: CONFIG.agent.id },
  nativePartStore: null,
});

let actualPort = PORT;
let agentClient = null;
let agentStarting = null;
let shuttingDown = false;
let dispatchedTools = 0;

const sessions = new Map(); // agentSessionId -> { canvasId, storeSessionId, token, cwd }
const tokens = new Map(); // bridge token -> { canvasId, storeSessionId, agentSessionId }
const activeTurns = new Map(); // canvasId -> active turn

const LOG_PATH = path.join(DATA_DIR, 'acp-host', 'host.log');

// 只记协议/工具名/会话 id；不写 prompt 正文、凭据或附件内容。
function log(...args) {
  const raw = args.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ');
  const text = raw
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]')
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-token]');
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${text}\n`);
  } catch {
    // 日志失败不影响协议。
  }
  if (CONFIG.debug) console.error('[acp-host]', text);
}

function debug(...args) {
  log(...args);
}

// 只有绝对路径或 PATH 上真实存在的命令才算可用；health 不能替一个拼错的命令报 ok。
function commandAvailable(command) {
  if (!command) return false;
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) return fs.existsSync(command);
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean)
    .some((dir) => exts.some((ext) => fs.existsSync(path.join(dir, command + ext))));
}

function humanizeAgentError(message) {
  const text = String(message || '');
  if (/not logged in|login required|unauthorized|401|credentials|auth/i.test(text)) {
    return `外部 agent 未登录或凭据失效，请先在终端完成登录后重试（Codex: codex login）。原始错误：${text}`;
  }
  if (/ENOENT|not found|no such file/i.test(text)) {
    return `找不到 agent 命令或入口：${CONFIG.agent.command}。请检查 DATA_DIR/acp_host.json。`;
  }
  return text;
}

function timingSafeMatch(got, expected) {
  const a = Buffer.from(String(got ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function instanceProof() {
  if (!INSTANCE_NONCE) return '';
  return crypto.createHash('sha256').update(INSTANCE_NONCE).digest('hex').slice(0, 16);
}

function instanceOK(req) {
  if (!INSTANCE_NONCE) return true;
  return timingSafeMatch(req.headers['x-beeftv-instance-nonce'] || '', INSTANCE_NONCE);
}

function authorized(req) {
  if (!instanceOK(req)) return { ok: false, reason: 'instance_mismatch' };
  if (!timingSafeMatch(req.headers['x-beeftv-agent-token'] || '', HOST_TOKEN)) return { ok: false, reason: 'unauthorized' };
  const origin = String(req.headers.origin || '');
  if (ALLOWED_ORIGIN && origin && origin !== ALLOWED_ORIGIN) return { ok: false, reason: 'origin_rejected' };
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return { ok: false, reason: 'host_rejected' };
  return { ok: true };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('body_too_large');
      error.tooLarge = true;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendLine(res, payload) {
  if (!res || res.destroyed || res.writableEnded) return;
  try {
    res.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // 客户端离开不终止回合；Go 仍有自己的 complete 回执。
  }
}

function newTurnId() {
  return crypto.randomUUID();
}

function descriptorToolNames() {
  return [...ops.descriptors.keys()];
}

async function loadDescriptorsWithRetry(attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const count = await ops.loadDescriptors();
      console.error(`acp-host: 载入 ${count} 个操作`);
      return true;
    } catch (error) {
      console.error(`acp-host: 能力发现失败（第 ${attempt} 次）：${error?.message || error}`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(3000, attempt * 500)));
    }
  }
  return false;
}

// ---------------------------------------------------------------- agent

function permissionOutcome(params) {
  const toolCall = params?.toolCall || {};
  const text = JSON.stringify(toolCall).toLowerCase();
  const known = descriptorToolNames();
  const isBeefTool = known.some((name) => text.includes(name.toLowerCase()))
    || ['canvas_get', 'canvas_search', 'canvas_nodes_create', 'canvas_node_update', 'canvas_generation_propose'].some((name) => text.includes(name));
  const options = Array.isArray(params?.options) ? params.options : [];
  const title = String(toolCall.title || toolCall.kind || 'tool').slice(0, 120);
  if (isBeefTool) {
    const allow = options.find((option) => String(option.kind || '').startsWith('allow'))
      || options.find((option) => /allow|approve/i.test(String(option.name || '')));
    if (allow) {
      log(`permission allow tool=${title} option=${allow.optionId}`);
      return { outcome: { outcome: 'selected', optionId: allow.optionId } };
    }
    log(`permission cancelled(no allow option) tool=${title}`);
    return { outcome: { outcome: 'cancelled' } };
  }
  const reject = options.find((option) => String(option.kind || '').startsWith('reject'))
    || options.find((option) => /reject|deny/i.test(String(option.name || '')));
  if (reject) {
    log(`permission reject tool=${title} option=${reject.optionId}`);
    return { outcome: { outcome: 'selected', optionId: reject.optionId } };
  }
  log(`permission cancelled tool=${title}`);
  return { outcome: { outcome: 'cancelled' } };
}

async function ensureClient() {
  if (agentClient && !agentClient.closed) return agentClient;
  if (agentStarting) return agentStarting;
  agentStarting = (async () => {
    if (!CONFIG.agent.command) throw new Error('agent_not_configured');
    const client = new AcpClient({
      command: CONFIG.agent.command,
      args: CONFIG.agent.args,
      env: agentEnvironment(CONFIG),
      cwd: path.join(DATA_DIR, 'acp-host'),
      clientInfo: { name: 'beeftv-acp-host', version: '0.1.0' },
      onPermission: permissionOutcome,
    });
    client.on('exit', () => {
      if (agentClient === client) agentClient = null;
    });
    client.on('stderr', () => {
      log(`[agent] ${client.stderrTail(1).slice(0, 300)}`);
    });
    client.on('protocol-error', (error) => log(`agent 协议错误 ${error?.message || error}`));
    await client.start();
    agentClient = client;
    log(`agent 已启动 ${CONFIG.agent.command} (${client.agentInfo?.name || 'unknown'} ${client.agentInfo?.version || ''})`);
    return client;
  })().finally(() => {
    agentStarting = null;
  });
  return agentStarting;
}

function removeSessionEntry(entry) {
  if (!entry) return;
  sessions.delete(entry.agentSessionId);
  tokens.delete(entry.token);
}

async function ensureAgentSession(canvasId, record) {
  const existing = [...sessions.values()].find((item) => item.canvasId === canvasId && item.storeSessionId === record.sessionId);
  if (existing) return existing;
  for (const [agentSessionId, item] of sessions) {
    if (item.canvasId !== canvasId) continue;
    sessions.delete(agentSessionId);
    tokens.delete(item.token);
  }
  const client = await ensureClient();
  const token = crypto.randomUUID();
  const callback = `http://127.0.0.1:${actualPort}/_mcp`;
  const mcpServers = [{
    name: 'beeftv',
    command: process.execPath,
    args: [BRIDGE_PATH],
    env: [
      { name: 'BEEFTV_ACP_CALLBACK', value: callback },
      { name: 'BEEFTV_ACP_TOKEN', value: token },
    ],
  }];
  const cwd = CONFIG.agent.cwd || agentWorkspace(DATA_DIR, canvasId);
  let agentSessionId = '';
  if (record.agentSessionId) {
    try {
      const loaded = await client.loadSession({ sessionId: record.agentSessionId, cwd, mcpServers });
      agentSessionId = loaded?.sessionId || record.agentSessionId;
      debug(`恢复 ACP 会话 ${agentSessionId}`);
    } catch (error) {
      debug(`恢复 ACP 会话失败，改为新会话：${error?.message || error}`);
    }
  }
  if (!agentSessionId) {
    const created = await client.newSession({ cwd, mcpServers });
    agentSessionId = created.sessionId;
    const options = (created.configOptions || []).map((item) => `${item.id}=${item.currentValue}`).join(',');
    log(`新建 ACP 会话 ${agentSessionId} options=[${options}]`);
  }
  record.agentSessionId = agentSessionId;
  store.save(canvasId, record);
  const entry = { canvasId, storeSessionId: record.sessionId, agentSessionId, token, cwd };
  sessions.set(agentSessionId, entry);
  tokens.set(token, entry);
  if (CONFIG.agent.model) {
    try {
      await client.setConfigOption(agentSessionId, 'model', CONFIG.agent.model);
      log(`设置模型 ${CONFIG.agent.model} 成功`);
    } catch (error) {
      log(`设置模型失败：${error?.message || error}`);
    }
  }
  return entry;
}

// ---------------------------------------------------------------- MCP bridge

function listMcpTools() {
  const tools = [];
  for (const [name, descriptor] of ops.descriptors) {
    if (!Array.isArray(descriptor.assistantModes) || descriptor.assistantModes.length === 0) continue;
    tools.push({
      name,
      description: String(descriptor.summary || descriptor.id),
      inputSchema: scopedSchema(descriptor.params, descriptor.id === 'canvas.get', descriptor.id),
    });
  }
  return tools;
}

function toMcpContent(result) {
  const content = [];
  for (const part of result?.content || []) {
    if (part?.type === 'text' && typeof part.text === 'string') content.push({ type: 'text', text: part.text });
    else if (part?.type === 'image' && part.data && part.mimeType) content.push({ type: 'image', data: part.data, mimeType: part.mimeType });
  }
  if (content.length === 0) content.push({ type: 'text', text: JSON.stringify(result ?? {}) });
  return content;
}

async function callMcpTool(entry, name, args) {
  const active = activeTurns.get(entry.canvasId);
  if (!active || active.storeSessionId !== entry.storeSessionId) {
    throw new Error('turn_not_active: 当前没有进行中的助手回合');
  }
  const tools = ops.buildTools(active.canvasId, active.log, active.generation, active.turn, active.storeSessionId);
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`tool_not_available: ${name}`);
  dispatchedTools += 1;
  return turnBudgetContext.run(active.budget, () => tool.execute(`mcp-${crypto.randomUUID()}`, args || {}, undefined));
}

async function handleMcp(req, res) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const entry = tokens.get(token);
  if (!entry) {
    sendJson(res, 403, { ok: false, error: 'invalid_bridge_token' });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String(error?.message || error) });
    return;
  }
  try {
    if (payload.method === 'list') {
      const tools = listMcpTools();
      log(`mcp list ${tools.length} tools`);
      sendJson(res, 200, { ok: true, result: tools });
      return;
    }
    if (payload.method === 'call') {
      const name = String(payload.name || '');
      log(`mcp call ${name}`);
      const result = await callMcpTool(entry, name, payload.arguments || {});
      sendJson(res, 200, { ok: true, result: { content: toMcpContent(result) } });
      return;
    }
    sendJson(res, 400, { ok: false, error: 'unknown_method' });
  } catch (error) {
    log(`mcp call ${payload?.name || ''} failed: ${error?.message || error}`);
    sendJson(res, 200, { ok: false, error: String(error?.message || error) });
  }
}

// ---------------------------------------------------------------- turn

function activeFor(canvasId) {
  return activeTurns.get(canvasId) || null;
}

// 技能正文按内容指纹缓存：同一固定版本只向 Go 读一次，进程重启后重新读。
const skillCache = new Map();

function escapeXml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

async function skillsBlock(pins, turnId) {
  const list = Array.isArray(pins)
    ? pins.filter((pin) => pin && pin.skillId && pin.versionId && pin.contentHash)
    : [];
  if (list.length === 0) return '';
  const blocks = [];
  for (const pin of list) {
    try {
      let cached = skillCache.get(pin.contentHash);
      if (!cached) {
        const response = await ops.opsRequest('POST', '/ops/skill.get', {
          params: { skillId: pin.skillId, versionId: pin.versionId, contentHash: pin.contentHash },
        }, undefined, turnId);
        // 操作层统一把业务结果放在 data.result 里。
        const data = response?.result || response || {};
        cached = {
          name: data.name || pin.skillName || pin.skillId,
          version: data.version || pin.version || '',
          instruction: String(data.instruction || ''),
        };
        skillCache.set(pin.contentHash, cached);
        log(`skill loaded ${cached.name}@${cached.version} chars=${cached.instruction.length}`);
      }
      if (cached.instruction.trim()) {
        blocks.push(`<skill name="${escapeXml(cached.name)}" version="${escapeXml(cached.version)}">\n${cached.instruction}\n</skill>`);
      }
    } catch (error) {
      blocks.push(`（技能 ${escapeXml(pin.skillName || pin.skillId)} 读取失败：${escapeXml(error?.message || error)}）`);
    }
  }
  return blocks.length > 0 ? `[本轮已选技能]\n${blocks.join('\n')}` : '';
}

function buildPromptBlocks(active, record, body, skills) {
  const context = turnContextPrefix({
    canvasId: body.canvasId,
    selectedNodeIds: Array.isArray(body.selectedNodeIds) ? body.selectedNodeIds : [],
    references: Array.isArray(body.references) ? body.references : [],
    permissionMode: active.generation.permissionMode,
  });
  const firstTurn = record.turns.length === 0;
  const prefix = firstTurn ? `${SYSTEM_PROMPT}\n\n[本轮上下文] ${context}` : `[本轮上下文] ${context}`;
  const skillsPart = skills ? `\n\n${skills}` : '';
  return [{ type: 'text', text: `${prefix}${skillsPart}\n\n用户请求：\n${body.message || '（用户只提供了素材，没有文字说明）'}` }];
}

async function appendAttachmentBlocks(blocks, body, turnId) {
  for (const attachment of Array.isArray(body.attachments) ? body.attachments : []) {
    if (!attachment?.resourceId) continue;
    if (attachment.kind === 'audio') {
      blocks.push({ type: 'text', text: `用户附了一段音频（${attachment.name || attachment.resourceId}）。当前 ACP 文本模型不能直接听取音频，只能由工具做客观检测；不要凭空描述声音内容。` });
      continue;
    }
    if (attachment.kind !== 'image' && attachment.kind !== 'video') continue;
    try {
      const reference = {
        canvasId: body.canvasId,
        ...(attachment.nodeId ? { nodeId: attachment.nodeId } : attachment.assetId ? { assetId: attachment.assetId } : {}),
        resourceId: attachment.resourceId,
      };
      const overview = await ops.opsRequest('POST', '/ops/media.overview', { params: reference }, undefined, turnId);
      const version = overview?.result?.source?.version;
      if (!version) throw new Error('missing_version');
      const params = { ...reference, expectedVersion: version, mode: 'frames' };
      if (attachment.kind === 'video') {
        const startMs = Math.max(0, Math.round(Number(attachment.start ?? 0) * 1000));
        const endMs = Math.max(startMs + 1000, Math.round(Number(attachment.end ?? 15) * 1000));
        params.startMs = startMs;
        params.endMs = Math.min(startMs + 15_000, endMs);
      }
      const inspected = await ops.opsRequest('POST', '/ops/media.inspect', { params }, undefined, turnId);
      if (attachment.kind === 'video') {
        blocks.push({ type: 'text', text: `用户附了一段视频（${attachment.name || attachment.resourceId}）。下面是从该片段抽取的静态帧，只能据此判断画面与构图，不能判断连续动作、运镜或声音。` });
      }
      for (const part of inspected?.result?.content || []) {
        if (part?.type === 'image' && part.data) blocks.push({ type: 'image', data: part.data, mimeType: part.mimeType || 'image/png' });
      }
    } catch (error) {
      blocks.push({ type: 'text', text: `用户附了一份素材（${attachment.name || attachment.resourceId}），但当前无法读取：${error?.message || error}` });
    }
  }
}

function mapStopReason(stopReason, active) {
  if (active.cancelled || active.generation.aborted || stopReason === 'cancelled') {
    return { cancelled: true, error: null, errorReason: null };
  }
  if (stopReason === 'refusal') return { cancelled: false, error: '模型拒绝了这次请求。', errorReason: 'model_refusal' };
  if (stopReason === 'max_tokens') return { cancelled: false, error: '本轮回复达到长度上限，已停止。', errorReason: 'max_tokens' };
  if (stopReason === 'max_turn_requests') return { cancelled: false, error: '本轮工具调用次数达到上限，已停止。', errorReason: 'max_turn_requests' };
  return { cancelled: false, error: null, errorReason: null };
}

async function finishTurn(active, payload) {
  if (active.finished) return;
  active.finished = true;
  activeTurns.delete(active.canvasId);
  store.clearActive(active.canvasId);
  const record = {
    turnId: active.turnId,
    userText: active.userText,
    reply: payload.reply,
    toolCalls: payload.toolCalls,
    change: payload.change,
    proposals: payload.proposals,
    error: payload.error,
    errorReason: payload.errorReason,
    cancelled: payload.cancelled,
    permissionMode: active.generation.permissionMode,
    skills: active.skills,
    createdAt: active.createdAt,
  };
  try {
    store.appendTurn(active.canvasId, active.storeSessionId, record);
  } catch (error) {
    console.error(`acp-host: 会话落盘失败 ${error?.message || error}`);
  }
  sendLine(active.res, { type: 'turn_end', turnId: active.turnId, sessionId: active.storeSessionId, ...payload });
  if (active.res && !active.res.destroyed && !active.res.writableEnded) {
    try { active.res.end(); } catch { /* 客户端已断开 */ }
  }
  try {
    await ops.opsRequest('POST', `/assistant/runtime/turns/${encodeURIComponent(active.turnId)}/complete`, {});
  } catch (error) {
    debug(`结算回执失败：${error?.message || error}`);
  }
  log(`turn end ${active.turnId} reply=${payload.reply.length} tools=${payload.toolCalls?.length || 0} cancelled=${Boolean(payload.cancelled)} error=${payload.error || ''}`);
}

async function runTurn(active, record, body) {
  const res = active.res;
  let updateListener = null;
  try {
    const client = await ensureClient();
    const entry = await ensureAgentSession(body.canvasId, record);
    active.agentSessionId = entry.agentSessionId;
    log(`prompt start canvas=${body.canvasId} turn=${active.turnId} session=${entry.agentSessionId} mode=${active.generation.permissionMode}`);
    updateListener = (params) => {
      if (params?.sessionId && params.sessionId !== entry.agentSessionId) return;
      const update = params?.update || {};
      if (update.sessionUpdate === 'agent_message_chunk') {
        const content = update.content;
        if (content?.type === 'text' && typeof content.text === 'string' && content.text) {
          active.reply += content.text;
          sendLine(res, { type: 'text_delta', delta: content.text });
        }
        return;
      }
      if (update.sessionUpdate === 'tool_call') {
        const name = String(update.title || update.kind || 'tool');
        active.toolNames.set(update.toolCallId, name);
        sendLine(res, { type: 'lifecycle', phase: 'tool', toolName: name });
        if (['completed', 'failed'].includes(String(update.status || ''))) {
          sendLine(res, { type: 'lifecycle', phase: 'tool_end', toolName: name });
        }
        return;
      }
      if (update.sessionUpdate === 'tool_call_update') {
        const name = active.toolNames.get(update.toolCallId) || String(update.title || 'tool');
        if (['completed', 'failed'].includes(String(update.status || ''))) {
          sendLine(res, { type: 'lifecycle', phase: 'tool_end', toolName: name });
        }
      }
    };
    client.on('update', updateListener);
    const skillText = await skillsBlock(record.skills, active.turnId);
    const blocks = buildPromptBlocks(active, record, body, skillText);
    await appendAttachmentBlocks(blocks, body, active.turnId);
    const promptPromise = client.prompt(entry.agentSessionId, blocks);
    promptPromise.catch(() => {
      // 超时后结果不再等待；这里只吞掉迟到的 rejection，避免 unhandled。
    });
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        active.timedOut = true;
        active.generation.aborted = true;
        try { client.cancel(entry.agentSessionId); } catch { /* agent 可能已退出 */ }
        reject(Object.assign(new Error('turn_timeout'), { reason: 'turn_timeout' }));
      }, CONFIG.limits.turnTimeoutMs);
    });
    let result;
    try {
      result = await Promise.race([promptPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    log(`prompt stop reason=${result?.stopReason || 'unknown'} reply=${active.reply.length} tools=${active.log.length}`);
    const outcome = mapStopReason(result?.stopReason, active);
    await finishTurn(active, {
      reply: active.reply,
      toolCalls: active.log,
      change: turnChange(active.turn),
      proposals: active.turn.proposals,
      cancelled: outcome.cancelled,
      error: outcome.error,
      errorReason: outcome.errorReason,
    });
  } catch (error) {
    const message = String(error?.message || error);
    log(`prompt failed turn=${active.turnId}: ${message}`);
    const timedOut = active.timedOut || error?.reason === 'turn_timeout' || /turn_timeout/.test(message);
    const cancelled = !timedOut && (active.cancelled || active.generation.aborted || /aborted/i.test(message));
    await finishTurn(active, {
      reply: active.reply,
      toolCalls: active.log,
      change: turnChange(active.turn),
      proposals: active.turn.proposals,
      cancelled,
      error: timedOut ? '这一轮处理超时，已停止继续执行。' : cancelled ? null : humanizeAgentError(message),
      errorReason: timedOut ? 'turn_timeout' : cancelled ? null : 'agent_error',
    });
  } finally {
    if (updateListener && agentClient) agentClient.off('update', updateListener);
  }
}

async function handleChat(res, body) {
  const canvasId = String(body.canvasId || '').trim();
  const turnId = String(body.turnId || '').trim();
  const userText = String(body.message || '').trim();
  if (!canvasId || !turnId || (!userText && !(Array.isArray(body.attachments) && body.attachments.length))) {
    sendJson(res, 400, { code: 400, reason: 'invalid_request' });
    return;
  }
  if (!CONFIG.agent.command) {
    sendJson(res, 503, { code: 503, reason: 'agent_not_configured' });
    return;
  }
  if (activeTurns.has(canvasId)) {
    sendJson(res, 409, { code: 409, reason: 'session_busy' });
    return;
  }
  // 权限只能来自 Go 的回合记录，宿主和 agent 都不能自报。
  let authority;
  try {
    authority = await ops.opsRequest('GET', `/assistant/runtime/turns/${encodeURIComponent(turnId)}`);
  } catch (error) {
    sendJson(res, 409, { code: 409, reason: 'turn_not_open', message: String(error?.message || error) });
    return;
  }
  if (!authority || authority.canvasId !== canvasId || authority.open === false) {
    sendJson(res, 409, { code: 409, reason: 'turn_not_open' });
    return;
  }
  const permissionMode = authority.permissionMode || body.permissionMode || 'canvas';

  let record = body.sessionId ? store.get(canvasId, String(body.sessionId)) : store.get(canvasId, store.currentSessionId(canvasId));
  if (!record) record = store.create(canvasId);
  // UI 每次明确选择技能时下发 pins；空数组表示清空。固定版本正文在回合开始时读取。
  if (Array.isArray(body.skills)) {
    record.skills = body.skills.filter((pin) => pin && pin.skillId && pin.versionId && pin.contentHash);
    store.save(canvasId, record);
  }
  const generation = {
    permissionMode,
    aborted: false,
    durable: false,
    pendingInput: null,
    pendingInputError: null,
    modelEpoch: 0,
    intentEpoch: 0,
  };
  const turn = resetTurnAccumulator(newTurnAccumulator(), body.revisionBefore, turnId);
  turn.canvasId = canvasId;
  const active = {
    canvasId,
    turnId,
    storeSessionId: record.sessionId,
    agentSessionId: '',
    userText,
    generation,
    turn,
    budget: createTurnBudget({ maxToolSteps: CONFIG.limits.toolStepsPerTurn }),
    log: [],
    reply: '',
    cancelled: false,
    skills: Array.isArray(record.skills) ? record.skills : [],
    createdAt: new Date().toISOString(),
    startedAt: Date.now(),
    toolNames: new Map(),
    res,
    finished: false,
  };
  activeTurns.set(canvasId, active);
  store.setActive(canvasId, { turnId, sessionId: record.sessionId, userText, startedAt: active.createdAt });

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  sendLine(res, { type: 'session', sessionId: record.sessionId, turnId });
  void runTurn(active, record, body);
}

// ---------------------------------------------------------------- HTTP

function readAssistantBody(body, res) {
  let payload;
  try {
    payload = JSON.parse(body || '{}');
  } catch {
    sendJson(res, 400, { code: 400, reason: 'invalid_request' });
    return null;
  }
  return payload;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (req.method === 'POST' && url.pathname === '/_mcp') {
    await handleMcp(req, res);
    return;
  }
  if (url.pathname === '/health') {
    if (!instanceOK(req)) {
      sendJson(res, 403, { code: 403, reason: 'instance_mismatch' });
      return;
    }
    const configured = Boolean(CONFIG.agent.command);
    const available = configured && commandAvailable(CONFIG.agent.command);
    sendJson(res, 200, {
      ok: available,
      reason: available ? undefined : configured ? 'agent_not_found' : 'agent_not_configured',
      sessions: sessions.size,
      busy: activeTurns.size > 0,
      model: CONFIG.agent.model || CONFIG.agent.id,
      api: 'acp',
      baseUrl: '',
      persistence: 'acp',
      runId: RUN_ID,
      instance: instanceProof() || undefined,
      requests: { dispatched: dispatchedTools, perTurnToolSteps: CONFIG.limits.toolStepsPerTurn },
      operations: ops.descriptors.size,
      readOnly: false,
    });
    return;
  }
  const auth = authorized(req);
  if (!auth.ok) {
    sendJson(res, 403, { code: 403, reason: auth.reason });
    return;
  }

  try {
    if (req.method === 'GET' && url.pathname === '/tools') {
      const canvasId = url.searchParams.get('canvasId') || '';
      const active = activeFor(canvasId);
      sendJson(res, 200, { canvasId, activeTools: active ? [...active.toolNames.values()] : [], known: descriptorToolNames() });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/active') {
      const canvasId = String(url.searchParams.get('canvasId') || '');
      const active = activeFor(canvasId);
      sendJson(res, 200, {
        sessionId: active?.storeSessionId || store.currentSessionId(canvasId) || null,
        turnId: active?.turnId || null,
        busy: Boolean(active),
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/sessions') {
      const canvasId = String(url.searchParams.get('canvasId') || '').trim();
      if (!canvasId) {
        sendJson(res, 400, { code: 400, reason: 'invalid_request' });
        return;
      }
      const list = store.list(canvasId);
      const current = store.currentSessionId(canvasId) || null;
      if (current && !list.some((item) => item.sessionId === current)) {
        list.unshift({ sessionId: current, title: '', updatedAt: new Date().toISOString(), turnCount: 0 });
      }
      sendJson(res, 200, { currentSessionId: current, sessions: list });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/sessions') {
      const payload = readAssistantBody(await readBody(req), res);
      if (!payload) return;
      const canvasId = String(payload.canvasId || '').trim();
      if (!canvasId) {
        sendJson(res, 400, { code: 400, reason: 'invalid_request' });
        return;
      }
      if (activeTurns.has(canvasId)) {
        sendJson(res, 409, { code: 409, reason: 'session_busy' });
        return;
      }
      const record = store.create(canvasId);
      sendJson(res, 200, { sessionId: record.sessionId });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/sessions/activate') {
      const payload = readAssistantBody(await readBody(req), res);
      if (!payload) return;
      const canvasId = String(payload.canvasId || '').trim();
      const sessionId = String(payload.sessionId || '').trim();
      if (!canvasId || !sessionId) {
        sendJson(res, 400, { code: 400, reason: 'invalid_request' });
        return;
      }
      if (activeTurns.has(canvasId)) {
        sendJson(res, 409, { code: 409, reason: 'session_busy' });
        return;
      }
      const record = store.activate(canvasId, sessionId);
      sendJson(res, 200, { sessionId: record.sessionId });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/history') {
      const canvasId = String(url.searchParams.get('canvasId') || '').trim();
      if (!canvasId) {
        sendJson(res, 400, { code: 400, reason: 'invalid_request' });
        return;
      }
      try {
        sendJson(res, 200, store.history(canvasId, String(url.searchParams.get('sessionId') || '').trim()));
      } catch (error) {
        sendJson(res, 404, { code: 404, reason: error?.reason || 'session_not_found' });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/cancel') {
      const payload = readAssistantBody(await readBody(req), res);
      if (!payload) return;
      const canvasId = String(payload.canvasId || '').trim();
      const active = activeFor(canvasId);
      if (!active) {
        sendJson(res, 404, { code: 404, reason: 'session_not_found' });
        return;
      }
      active.cancelled = true;
      active.generation.aborted = true;
      if (agentClient && active.agentSessionId) {
        try { agentClient.cancel(active.agentSessionId); } catch { /* agent 可能已退出 */ }
      }
      sendJson(res, 202, { accepted: true, busy: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/steer') {
      await readBody(req);
      sendJson(res, 501, { code: 501, reason: 'steer_unsupported', msg: '当前 ACP 运行时不支持运行中补充输入' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/chat') {
      const payload = readAssistantBody(await readBody(req), res);
      if (!payload) return;
      await handleChat(res, payload);
      return;
    }
    if (url.pathname === '/skill-context') {
      sendJson(res, 404, { code: 404, reason: 'not_supported' });
      return;
    }
    sendJson(res, 404, { code: 404, reason: 'not_found' });
  } catch (error) {
    if (error?.tooLarge) {
      if (!res.headersSent) sendJson(res, 413, { code: 413, reason: 'body_too_large' });
      return;
    }
    console.error(`acp-host: 请求失败 ${error?.message || error}`);
    if (!res.headersSent) sendJson(res, 500, { code: 500, reason: 'internal_error', message: String(error?.message || error) });
  }
});

async function recoverStaleTurns() {
  const root = path.join(DATA_DIR, 'acp-host');
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const activeFile = path.join(root, entry.name, 'active.json');
    let active = null;
    try {
      active = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
    } catch {
      continue;
    }
    if (!active?.turnId) continue;
    try {
      await ops.opsRequest('POST', `/assistant/runtime/turns/${encodeURIComponent(active.turnId)}/complete`, {});
      console.error(`acp-host: 已结算上次中断的回合 ${active.turnId}`);
    } catch (error) {
      debug(`结算悬空回合失败 ${active.turnId}: ${error?.message || error}`);
    }
    try { fs.rmSync(activeFile, { force: true }); } catch { /* 忽略 */ }
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const active of activeTurns.values()) {
    active.cancelled = true;
    try { agentClient?.cancel(active.agentSessionId); } catch { /* 忽略 */ }
  }
  await agentClient?.dispose();
  await new Promise((resolve) => server.close(() => resolve()));
  process.exit(0);
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
if (LIFETIME_STDIN) {
  process.stdin.resume();
  process.stdin.on('end', () => { void shutdown(); });
  process.stdin.on('error', () => { void shutdown(); });
}

await loadDescriptorsWithRetry();
void recoverStaleTurns();
function onListen() {
  const bound = server.address();
  actualPort = bound && typeof bound === 'object' ? bound.port : PORT;
  console.log(`acp-host 已启动 http://127.0.0.1:${actualPort} agent=${CONFIG.agent.command} model=${CONFIG.agent.model || CONFIG.agent.id} ops=${OPS_URL}`);
}
if (LISTEN_FD > 0) server.listen({ fd: LISTEN_FD }, onListen);
else server.listen(PORT, '127.0.0.1', onListen);
