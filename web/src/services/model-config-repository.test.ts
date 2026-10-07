import assert from "node:assert/strict";
import test from "node:test";

import { shouldMigrateLocalModelConfig } from "@/lib/workspace-model-config";
import { createModelConfigRepository } from "@/services/model-config-repository";
import type { AiConfig } from "@/stores/use-config-store";

function configWithChannel(name: string): AiConfig {
    return { channels: [{ id: name, name, baseUrl: "https://example.com", apiKey: "key-" + name, models: [] }] } as unknown as AiConfig;
}

test("shouldMigrateLocalModelConfig：后端为默认空配置且本地有渠道时触发迁移", () => {
    assert.equal(shouldMigrateLocalModelConfig({ health: "default", localChannelCount: 3 }), true);
});

test("shouldMigrateLocalModelConfig：后端已有配置时不迁移（后端为准）", () => {
    assert.equal(shouldMigrateLocalModelConfig({ health: "ready", localChannelCount: 3 }), false);
    assert.equal(shouldMigrateLocalModelConfig({ health: "migrated", localChannelCount: 3 }), false);
});

test("shouldMigrateLocalModelConfig：本地没有渠道时无事可做", () => {
    assert.equal(shouldMigrateLocalModelConfig({ health: "default", localChannelCount: 0 }), false);
});

test("409 冲突重试时使用最新本地配置而不是过期快照", async () => {
    const written: string[] = [];
    let revision = 0;
    let conflicts = 1;
    const repository = createModelConfigRepository({
        read: async () => ({ config: configWithChannel("backend"), revision: ++revision, health: "ready", source: "builtin+local" }),
        write: async (config, expectedRevision) => {
            written.push(config.channels[0]?.id ?? "?");
            if (conflicts > 0) {
                conflicts -= 1;
                const error = new Error("conflict") as Error & { status?: number };
                error.status = 409;
                throw error;
            }
            return { saved: true, revision: ++revision };
        },
    });
    await repository.hydrate();
    repository.commit(configWithChannel("own"));
    await repository.flush();
    assert.deepEqual(written, ["own", "own"]);
    assert.equal(repository.getState().status, "saved");
    assert.equal(repository.getState().dirty, false);
});

test("重试时若本地配置已被清空则中止且不覆盖后端", async () => {
    const writes: string[] = [];
    let revision = 0;
    let conflicts = 1;
    const repository = createModelConfigRepository({
        read: async () => ({ config: configWithChannel("backend"), revision: ++revision, health: "ready", source: "builtin+local" }),
        write: async (config) => {
            writes.push(config.channels[0]?.id ?? "(空)");
            if (conflicts > 0) {
                conflicts -= 1;
                const error = new Error("conflict") as Error & { status?: number };
                error.status = 409;
                throw error;
            }
            return { saved: true, revision: ++revision };
        },
    });
    await repository.hydrate();
    repository.commit(configWithChannel("own"));
    repository.commit({ channels: [] } as unknown as AiConfig);
    await repository.flush();
    assert.equal(repository.getState().status, "saved");
    assert.equal(writes.at(-1), "(空)");
});
