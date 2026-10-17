import { expect, test } from "bun:test";
import { beginSkillContextMutation, finishSkillContextMutation, readSkillContextMutation, skillContextMutationKey } from "../src/pages/canvas/skill-context-mutation";

function storage() {
    const data = new Map<string, string>();
    return {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => {
            data.set(key, value);
        },
        removeItem: (key: string) => {
            data.delete(key);
        },
    };
}

test("uncertain reset reuses the receipt after retries and reload", () => {
    const s = storage(),
        key = skillContextMutationKey("owner", "canvas", "durable:one");
    const first = beginSkillContextMutation(s, key, "durable:one", "new_scope", 3);
    expect(readSkillContextMutation(s, key, "durable:one")).toEqual(first);
    expect(beginSkillContextMutation(s, key, "durable:one", "new_scope", 4)).toEqual(first);
    expect(beginSkillContextMutation(s, key, "durable:one", "clear", 4)).toEqual(first);
    finishSkillContextMutation(s, key, { ...first, requestId: "stale-response" });
    expect(readSkillContextMutation(s, key, "durable:one")).toEqual(first);
    finishSkillContextMutation(s, key, first);
    expect(beginSkillContextMutation(s, key, "durable:one", "new_scope", 4).requestId).not.toBe(first.requestId);
});

test("mutation receipts are isolated by owner canvas and durable session", () => {
    const keys = [skillContextMutationKey("a", "c", "s"), skillContextMutationKey("b", "c", "s"), skillContextMutationKey("a", "d", "s"), skillContextMutationKey("a", "c", "t")];
    expect(new Set(keys).size).toBe(4);
    const s = storage();
    for (const raw of ["{", "null", JSON.stringify({ sessionId: "s", action: "new_scope", expectedRevision: -1, requestId: "id" }), JSON.stringify({ sessionId: "other", action: "new_scope", expectedRevision: 1, requestId: "id" })]) {
        s.setItem(keys[0], raw);
        expect(readSkillContextMutation(s, keys[0], "s")).toBeNull();
    }
});
