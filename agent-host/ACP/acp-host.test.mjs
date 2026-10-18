import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

import { AcpClient } from './acp-client.mjs';
import { SessionStore } from './session-store.mjs';
import { readRuntimeConfig, agentEnvironment, agentWorkspace } from './runtime-config.mjs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const fakeAgent = path.join(here, 'fake-acp-agent.mjs');
const bridge = path.join(here, 'beef-mcp.mjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acp-test-'));
}

describe('ACP client', () => {
  let client = null;
  afterEach(async () => {
    await client?.dispose();
    client = null;
  });

  test('initializes, opens a session, streams updates and answers permission', async () => {
    const updates = [];
    client = new AcpClient({
      command: process.execPath,
      args: [fakeAgent],
      env: process.env,
      cwd: tempDir(),
      onPermission: () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }),
    });
    const init = await client.start();
    expect(init.protocolVersion).toBe(1);
    expect(client.agentInfo?.name).toBe('fake-acp');
    const session = await client.newSession({ cwd: tempDir(), mcpServers: [] });
    expect(session.sessionId).toBe('fake-session-1');
    client.on('update', (params) => updates.push(params.update));
    const result = await client.prompt(session.sessionId, [{ type: 'text', text: 'hello' }]);
    expect(result.stopReason).toBe('end_turn');
    expect(updates.some((item) => item.sessionUpdate === 'agent_message_chunk')).toBe(true);
    expect(updates.some((item) => item.sessionUpdate === 'tool_call')).toBe(true);
    const text = updates.filter((item) => item.sessionUpdate === 'agent_message_chunk').map((item) => item.content.text).join('');
    expect(text).toContain('permission=allow');
  });
});

describe('ACP runtime config', () => {
  test('defaults codex streaming args and never leaks BEEFTV secrets to the agent', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'acp_host.json'), JSON.stringify({ agent: { command: 'codex-acp.exe' } }));
    const config = readRuntimeConfig(dir);
    expect(config.agent.args).toEqual(['--message-streaming']);
    process.env.BEEFTV_AGENT_HOST_TOKEN = 'host-secret';
    try {
      const env = agentEnvironment(config);
      expect(env.BEEFTV_AGENT_HOST_TOKEN).toBeUndefined();
      expect(env.BEEFTV_AGENT_API_KEY).toBeUndefined();
      expect(env.PATH || env.Path).toBeTruthy();
    } finally {
      delete process.env.BEEFTV_AGENT_HOST_TOKEN;
    }
    const workspace = agentWorkspace(dir, 'canvas 1');
    expect(fs.existsSync(workspace)).toBe(true);
    expect(workspace.includes('canvas_1')).toBe(true);
  });
});

describe('ACP session store', () => {
  test('creates, appends and re-reads a session without touching pi sessions', () => {
    const root = tempDir();
    const store = new SessionStore({ root });
    const session = store.create('canvas-1');
    expect(session.sessionId.startsWith('acp:')).toBe(true);
    store.appendTurn('canvas-1', session.sessionId, {
      turnId: 'turn-1', userText: '读取画布', reply: '有 3 个节点', toolCalls: [], change: null,
      proposals: [], error: null, cancelled: false, createdAt: new Date().toISOString(),
    });
    expect(store.currentSessionId('canvas-1')).toBe(session.sessionId);
    const history = store.history('canvas-1');
    expect(history.turns).toHaveLength(1);
    expect(history.turns[0].reply).toContain('3 个节点');
    expect(store.list('canvas-1')[0].turnCount).toBe(1);
    expect(() => store.history('canvas-1', 'acp:missing')).toThrow();
  });
});

describe('MCP bridge', () => {
  test('forwards tools/list and tools/call to the host callback', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const payload = JSON.parse(body);
        seen.push({ auth: req.headers.authorization, payload });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (payload.method === 'list') {
          res.end(JSON.stringify({ ok: true, result: [{ name: 'canvas_get', description: 'read', inputSchema: { type: 'object' } }] }));
        } else {
          res.end(JSON.stringify({ ok: true, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }));
        }
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const child = spawn(process.execPath, [bridge], {
      env: {
        ...process.env,
        BEEFTV_ACP_CALLBACK: `http://127.0.0.1:${port}/_mcp`,
        BEEFTV_ACP_TOKEN: 'bridge-token',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses = [];
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) responses.push(JSON.parse(line));
      }
    });
    const waitFor = async (id) => {
      for (let i = 0; i < 100; i += 1) {
        const found = responses.find((item) => item.id === id);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`no response for ${id}`);
    };
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    const init = await waitFor(1);
    expect(init.result.serverInfo.name).toBe('beeftv');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    const list = await waitFor(2);
    expect(list.result.tools[0].name).toBe('canvas_get');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'canvas_get', arguments: { canvasId: 'c' } } })}\n`);
    const call = await waitFor(3);
    expect(call.result.content[0].text).toContain('ok');
    expect(seen.map((item) => item.payload.method)).toEqual(['list', 'call']);
    expect(seen.every((item) => item.auth === 'Bearer bridge-token')).toBe(true);
    child.stdin.end();
    child.kill();
    await new Promise((resolve) => server.close(resolve));
  });
});
