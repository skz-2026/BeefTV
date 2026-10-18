// ACP 宿主的运行配置：只读 DATA_DIR 下的 acp_host.json，不从请求体接收命令。
// 结构与 pi 宿主的 agent_config.json 分开，避免 Go 的 HostConfig 写回时把它抹掉。
import fs from 'node:fs';
import path from 'node:path';

const CONFIG_FILE = 'acp_host.json';

// 传给第三方 agent 的环境变量白名单：认证目录、PATH 和系统必需项。
// BEEFTV_* 一律不传，否则 agent 进程能拿到可调用全部 ops 的宿主 token。
const ENV_ALLOWLIST = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PROGRAMDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
]);

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

export function readRuntimeConfig(dataDir) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dataDir, CONFIG_FILE), 'utf8'));
  } catch {
    raw = {};
  }
  const agent = raw.agent && typeof raw.agent === 'object' ? raw.agent : {};
  const limits = raw.limits && typeof raw.limits === 'object' ? raw.limits : {};
  const command = String(agent.command || 'codex-acp').trim();
  const configuredArgs = Array.isArray(agent.args) ? agent.args.map((item) => String(item)) : [];
  return {
    agent: {
      id: String(agent.id || 'codex').trim() || 'codex',
      command,
      // codex-acp 默认不逐字流式输出；不开这个开关面板只能等整段回复。
      args: configuredArgs.length > 0 || !/codex-acp/i.test(command) ? configuredArgs : ['--message-streaming'],
      env: agent.env && typeof agent.env === 'object' && !Array.isArray(agent.env)
        ? Object.fromEntries(Object.entries(agent.env).map(([key, value]) => [String(key), String(value)]))
        : {},
      model: String(agent.model || '').trim(),
      cwd: String(agent.cwd || '').trim(),
    },
    limits: {
      toolStepsPerTurn: positiveInt(limits.toolStepsPerTurn, 40),
      sessionIdleMs: positiveInt(limits.sessionIdleMs, 30 * 60_000),
      turnTimeoutMs: positiveInt(limits.turnTimeoutMs, 30 * 60_000),
    },
    debug: raw.debug === true,
  };
}

export function agentEnvironment(config) {
  const out = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (ENV_ALLOWLIST.has(upper)) out[key] = value;
  }
  for (const [key, value] of Object.entries(config.agent.env)) out[key] = value;
  return out;
}

export function agentWorkspace(dataDir, canvasId) {
  const safe = String(canvasId || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'canvas';
  const dir = path.join(dataDir, 'acp-host', 'workspaces', safe);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
