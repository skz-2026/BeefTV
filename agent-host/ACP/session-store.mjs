// 段画布之外的第二套会话存储：ACP 会话与 pi 的官方 sessions/ 完全隔离。
// 目录是 fork 自己的格式，升级或回退 pi 宿主时互不覆盖。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SESSION_PREFIX = 'acp:';

export function isAcpSessionId(value) {
  return String(value || '').startsWith(SESSION_PREFIX);
}

export function newSessionId() {
  return `${SESSION_PREFIX}${crypto.randomUUID()}`;
}

function safeSegment(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'default';
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class SessionStore {
  constructor({ root }) {
    this.root = root;
  }

  canvasDir(canvasId) {
    return path.join(this.root, safeSegment(canvasId));
  }

  sessionFile(canvasId, sessionId) {
    return path.join(this.canvasDir(canvasId), `${safeSegment(sessionId)}.json`);
  }

  currentFile(canvasId) {
    return path.join(this.canvasDir(canvasId), 'current.json');
  }

  activeFile(canvasId) {
    return path.join(this.canvasDir(canvasId), 'active.json');
  }

  currentSessionId(canvasId) {
    const current = readJson(this.currentFile(canvasId));
    return typeof current?.sessionId === 'string' ? current.sessionId : '';
  }

  get(canvasId, sessionId) {
    if (!sessionId) return null;
    const value = readJson(this.sessionFile(canvasId, sessionId));
    if (!value || value.sessionId !== sessionId) return null;
    return {
      sessionId: value.sessionId,
      agentSessionId: typeof value.agentSessionId === 'string' ? value.agentSessionId : '',
      title: typeof value.title === 'string' ? value.title : '',
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
      skills: Array.isArray(value.skills) ? value.skills : [],
      turns: Array.isArray(value.turns) ? value.turns : [],
    };
  }

  save(canvasId, session) {
    session.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.sessionFile(canvasId, session.sessionId), session);
    return session;
  }

  create(canvasId) {
    const session = {
      sessionId: newSessionId(),
      agentSessionId: '',
      title: '',
      updatedAt: new Date().toISOString(),
      skills: [],
      turns: [],
    };
    this.save(canvasId, session);
    this.activate(canvasId, session.sessionId);
    return session;
  }

  activate(canvasId, sessionId) {
    const session = this.get(canvasId, sessionId);
    if (!session) throw Object.assign(new Error('session_not_found'), { reason: 'session_not_found' });
    writeJsonAtomic(this.currentFile(canvasId), { sessionId, updatedAt: new Date().toISOString() });
    return session;
  }

  list(canvasId) {
    let entries = [];
    try {
      entries = fs.readdirSync(this.canvasDir(canvasId));
    } catch {
      return [];
    }
    const sessions = [];
    for (const name of entries) {
      if (!name.endsWith('.json') || name === 'current.json' || name === 'active.json') continue;
      const value = readJson(path.join(this.canvasDir(canvasId), name));
      if (!value?.sessionId) continue;
      sessions.push({
        sessionId: value.sessionId,
        title: typeof value.title === 'string' ? value.title : '',
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
        turnCount: Array.isArray(value.turns) ? value.turns.length : 0,
      });
    }
    sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return sessions;
  }

  appendTurn(canvasId, sessionId, turn) {
    const session = this.get(canvasId, sessionId);
    if (!session) throw Object.assign(new Error('session_not_found'), { reason: 'session_not_found' });
    session.turns.push(turn);
    if (!session.title) {
      const first = session.turns.find((item) => String(item?.userText || '').trim());
      session.title = String(first?.userText || '').trim().slice(0, 40);
    }
    return this.save(canvasId, session);
  }

  history(canvasId, sessionId) {
    const id = sessionId || this.currentSessionId(canvasId);
    if (!id) return { sessionId: null, turns: [] };
    const session = this.get(canvasId, id);
    if (!session) throw Object.assign(new Error('session_not_found'), { reason: 'session_not_found' });
    const active = this.getActive(canvasId);
    return {
      sessionId: id,
      turns: session.turns,
      ...(active && active.sessionId === id ? { active: { turnId: active.turnId, userText: active.userText || '', createdAt: active.startedAt, status: 'running' } } : {}),
    };
  }

  setActive(canvasId, value) {
    writeJsonAtomic(this.activeFile(canvasId), value);
  }

  getActive(canvasId) {
    const value = readJson(this.activeFile(canvasId));
    return value && typeof value.turnId === 'string' ? value : null;
  }

  clearActive(canvasId) {
    try {
      fs.rmSync(this.activeFile(canvasId), { force: true });
    } catch {
      // active 文件只用于恢复提示，删不掉不影响回合结算。
    }
  }
}
