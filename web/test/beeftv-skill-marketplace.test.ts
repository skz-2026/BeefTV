import { expect, test } from "bun:test";

async function source(path: string) {
    return Bun.file(new URL(path, import.meta.url)).text();
}

test("Skill marketplace is reachable from the extensions entry and legacy URL", async () => {
    const [router, sidebar] = await Promise.all([source("../src/router.tsx"), source("../src/components/layout/workspace-sidebar-nav.tsx")]);
    expect(router).toContain('{ path: "/skill", element: <Navigate to="/skills" replace /> }');
    expect(router).toContain('{ path: "/skills", element: deferred(<SkillsPage />) }');
    expect(router).toContain('{ path: "/skills/reference", element: <Navigate to="/" replace /> }');
    expect(router).not.toContain("SkillsReferencePage");
    expect(sidebar).toContain('{ ...toolItem("skills", "/skills"), title: "扩展" }');
});
