#!/usr/bin/env node
// 在 DATA_DIR/agent_config.json 里切换内置助手宿主：pi（官方）或 ACP。
// 只改本机配置，不联网、不改代码、不碰 Go 数据库；切换后需要重启助手宿主。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

function stripBom(text) {
  return text.replace(/^\uFEFF/, '');
}

const dataDir = readArg('--data-dir') || process.env.BEEFTV_AGENT_DATA_DIR || '';
const runtime = (readArg('--runtime') || 'acp').toLowerCase();
const nodePath = readArg('--node') || process.execPath;
const showOnly = process.argv.includes('--show');

if (!dataDir) {
  console.error('用法：node switch-host.mjs --data-dir <DATA_DIR> [--runtime acp|pi] [--node <node.exe>] [--show]');
  process.exit(2);
}
if (runtime !== 'acp' && runtime !== 'pi') {
  console.error('--runtime 只能是 acp 或 pi');
  process.exit(2);
}

const file = path.join(dataDir, 'agent_config.json');
let config = {};
try {
  config = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
} catch {
  config = {};
}

if (showOnly) {
  console.log(JSON.stringify({ file, config }, null, 2));
  process.exit(0);
}

config.hostCommand = nodePath;
config.hostArgs = runtime === 'acp'
  ? [path.join(HERE, 'acp-host.mjs')]
  : [path.join(HERE, '..', 'server.mjs')];
config.updatedAt = new Date().toISOString();
if (!config.model) {
  console.warn('警告：agent_config.json 里没有 model。Go 的 /assistant/status 仍要求先配置一个文本模型，否则不会拉起宿主。');
}
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

console.log(`已切到 ${runtime === 'acp' ? 'ACP' : 'pi'} 宿主：`);
console.log(`  ${config.hostCommand} ${config.hostArgs.join(' ')}`);
console.log('下一步：重启应用，或在 BeefTV 里点助手「重试」/调用 POST /api/assistant/host/restart。');
if (runtime === 'acp') {
  console.log(`ACP 的 agent 配置在 ${path.join(dataDir, 'acp_host.json')}（见 README）。`);
}
