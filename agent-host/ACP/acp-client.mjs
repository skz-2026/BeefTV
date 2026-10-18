// 最小 ACP 客户端：只实现 BeefTV 宿主需要的 JSON-RPC over stdio。
// 不依赖 @agentclientprotocol/sdk，避免改上游 package.json / bun.lock。
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

class AcpError extends Error {
  constructor(message, { code = -32603, data = null, method = '' } = {}) {
    super(message);
    this.name = 'AcpError';
    this.code = code;
    this.data = data;
    this.method = method;
  }
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (!/[\s"&|<>^]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function spawnAgent(command, args, options) {
  const isWindows = process.platform === 'win32';
  if (isWindows && /\.(cmd|bat)$/i.test(command)) {
    // cmd.exe 才能执行 .cmd shim；用 windowsVerbatimArguments 避免 Node 再转义一次。
    const comspec = process.env.ComSpec || 'cmd.exe';
    const line = [command, ...args].map(quoteWindowsArg).join(' ');
    return spawn(comspec, ['/d', '/s', '/c', line], { ...options, windowsVerbatimArguments: true });
  }
  return spawn(command, args, options);
}

export class AcpClient extends EventEmitter {
  constructor({ command, args = [], env = {}, cwd, clientInfo, onPermission }) {
    super();
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.clientInfo = clientInfo || { name: 'beeftv-acp-host', version: '0.1.0' };
    this.onPermission = onPermission;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = [];
    this.closed = false;
    this.initialized = null;
    this.agentCapabilities = {};
    this.agentInfo = null;
  }

  async start() {
    if (this.child) return this.initialized;
    this.child = spawnAgent(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    this.child.stderr.on('data', (chunk) => this.#onStderr(chunk));
    this.child.on('error', (error) => this.#failAll(new AcpError(`agent 启动失败：${error.message}`)));
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      this.#failAll(new AcpError(`agent 进程已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`));
      this.emit('exit', { code, signal });
    });
    this.initialized = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: this.clientInfo,
    }, { timeoutMs: 30_000 });
    this.agentCapabilities = this.initialized?.agentCapabilities || {};
    this.agentInfo = this.initialized?.agentInfo || null;
    return this.initialized;
  }

  get capabilities() {
    return this.agentCapabilities;
  }

  async newSession({ cwd, mcpServers }) {
    const result = await this.request('session/new', { cwd, mcpServers }, { timeoutMs: 60_000 });
    if (!result?.sessionId) throw new AcpError('session/new 没有返回 sessionId');
    return result;
  }

  // codex-acp 声明 sessionCapabilities.resume；不同适配器的方法名可能不同。
  async loadSession({ sessionId, cwd, mcpServers }) {
    const errors = [];
    for (const method of ['session/load', 'session/resume']) {
      try {
        const result = await this.request(method, { sessionId, cwd, mcpServers }, { timeoutMs: 60_000 });
        return { ...result, sessionId: result?.sessionId || sessionId, method };
      } catch (error) {
        errors.push(`${method}: ${error.message}`);
        if (error?.code !== -32601) throw error;
      }
    }
    throw new AcpError(`无法恢复会话（${errors.join('；')}）`);
  }

  async setConfigOption(sessionId, configId, value) {
    return this.request('session/set_config_option', { sessionId, configId, value }, { timeoutMs: 30_000 });
  }

  prompt(sessionId, prompt, { signal, timeoutMs = 2 * 60 * 60_000 } = {}) {
    return this.request('session/prompt', { sessionId, prompt }, { signal, timeoutMs });
  }

  cancel(sessionId) {
    this.notify('session/cancel', { sessionId });
  }

  request(method, params, { timeoutMs = 60_000, signal } = {}) {
    if (this.closed || !this.child) return Promise.reject(new AcpError('agent 尚未启动'));
    if (signal?.aborted) return Promise.reject(new AcpError('aborted'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new AcpError(`${method} 超时（${Math.round(timeoutMs / 1000)}s）`, { method }));
        }, timeoutMs)
        : null;
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new AcpError('aborted', { method }));
      };
      this.pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
          reject(error);
        },
        method,
        onAbort,
      });
      signal?.addEventListener?.('abort', onAbort, { once: true });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  respond(id, result) {
    this.#write({ jsonrpc: '2.0', id, result });
  }

  respondError(id, code, message) {
    this.#write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  stderrTail(lines = 8) {
    return this.stderr.slice(-lines).join('\n');
  }

  async dispose() {
    this.closed = true;
    if (!this.child) return;
    try {
      this.child.stdin.end();
    } catch {
      // stdin 已关闭。
    }
    this.child.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #write(payload) {
    if (!this.child?.stdin?.writable || this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      this.emit('protocol-error', error);
    }
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '').trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // 协议行以外的 stdout 内容只进诊断，不当协议处理。
        this.emit('protocol-error', new Error(`非 JSON 行：${line.slice(0, 200)}`));
        continue;
      }
      this.#dispatch(message);
    }
  }

  #onStderr(chunk) {
    for (const line of String(chunk).split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      this.stderr.push(text);
      if (this.stderr.length > 200) this.stderr.shift();
    }
    this.emit('stderr');
  }

  #dispatch(message) {
    if (message.id !== undefined && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new AcpError(message.error.message || 'ACP 请求失败', {
          code: Number(message.error.code ?? -32603),
          data: message.error.data ?? null,
          method: pending.method,
        }));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method && message.id !== undefined) {
      void this.#handleAgentRequest(message);
      return;
    }
    if (message.method) {
      if (message.method === 'session/update') this.emit('update', message.params || {});
      this.emit('notification', message);
      return;
    }
    this.emit('protocol-error', new Error(`无法识别的 ACP 消息：${JSON.stringify(message).slice(0, 200)}`));
  }

  async #handleAgentRequest(message) {
    const { id, method, params } = message;
    try {
      if (method === 'session/request_permission') {
        const outcome = await this.onPermission?.(params || {});
        this.respond(id, outcome || { outcome: { outcome: 'cancelled' } });
        return;
      }
      // 没有声明 fs / terminal 能力；agent 仍调用时明确拒绝，让它走 BeefTV 工具。
      this.respondError(id, -32601, `不支持客户端方法：${method}`);
    } catch (error) {
      this.respondError(id, -32603, String(error?.message || error));
    }
  }

  #failAll(error) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}
