export type SkillContextAction = "refresh" | "clear" | "new_scope";
export type SkillContextMutation = { sessionId: string; action: SkillContextAction; expectedRevision: number; requestId: string };
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function skillContextMutationKey(owner: string, canvasId: string, sessionId: string) {
    return JSON.stringify(["beeftv-skill-context", owner, canvasId, sessionId]);
}

export function readSkillContextMutation(storage: StoragePort, key: string, sessionId: string): SkillContextMutation | null {
    const raw = storage.getItem(key);
    if (!raw) return null;
    let value: SkillContextMutation;
    try {
        value = JSON.parse(raw);
    } catch {
        storage.removeItem(key);
        return null;
    }
    if (!value || value.sessionId !== sessionId || !["refresh", "clear", "new_scope"].includes(value.action) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || typeof value.requestId !== "string" || !value.requestId) {
        storage.removeItem(key);
        return null;
    }
    return value;
}

export function beginSkillContextMutation(storage: StoragePort, key: string, sessionId: string, action: SkillContextAction, expectedRevision: number): SkillContextMutation {
    const previous = readSkillContextMutation(storage, key, sessionId);
    if (previous) return previous;
    const mutation = { sessionId, action, expectedRevision, requestId: crypto.randomUUID() };
    // Persist before sending: a timeout or page reload must retry the same operation.
    storage.setItem(key, JSON.stringify(mutation));
    return mutation;
}

export function finishSkillContextMutation(storage: StoragePort, key: string, mutation: SkillContextMutation) {
    if (readSkillContextMutation(storage, key, mutation.sessionId)?.requestId === mutation.requestId) storage.removeItem(key);
}
