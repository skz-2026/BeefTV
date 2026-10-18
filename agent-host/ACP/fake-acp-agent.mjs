// 契约测试替身：不发模型请求，只按脚本吐 ACP 事件。
// 用于验证 JSON-RPC framing、session/new、prompt 流、双向 permission 请求。
let buffer = '';
let nextId = 1000;
let pendingPromptId = null;
const pendingRequests = new Map();

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    setTimeout(() => reject(new Error(`fake agent timeout ${method}`)), 10_000);
  });
}

function update(sessionId, body) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: body } });
}

async function prompt(sessionId, id) {
  pendingPromptId = id;
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '正在读取画布…' } });
  let permission = 'rejected';
  try {
    const result = await request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'call-1', title: 'canvas_get', kind: 'other', status: 'pending', rawInput: { canvasId: 'demo' } },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    permission = result?.outcome?.outcome === 'selected' ? result.outcome.optionId : 'cancelled';
  } catch {
    permission = 'failed';
  }
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'canvas_get', kind: 'other', status: 'pending' });
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `画布有 3 个节点（permission=${permission}）。` } });
  pendingPromptId = null;
  send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && pendingRequests.has(message.id)) {
      const pending = pendingRequests.get(message.id);
      pendingRequests.delete(message.id);
      pending.resolve(message.result ?? message.error);
      continue;
    }
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} } },
        agentInfo: { name: 'fake-acp', version: '0.0.1' },
        authMethods: [],
      } });
      continue;
    }
    if (message.method === 'session/new') {
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fake-session-1', configOptions: [] } });
      continue;
    }
    if (message.method === 'session/load' || message.method === 'session/resume') {
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId: message.params?.sessionId || 'fake-session-1' } });
      continue;
    }
    if (message.method === 'session/prompt') {
      void prompt(message.params.sessionId, message.id);
      continue;
    }
    if (message.method === 'session/cancel') {
      if (pendingPromptId !== null) {
        send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'cancelled' } });
        pendingPromptId = null;
      }
      continue;
    }
    if (message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unsupported ${message.method}` } });
    }
  }
});
