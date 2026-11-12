import { describe, expect, it } from "vite-plus/test";

import {
  BUILT_IN_DIFF_FILE_RULES,
  compileDiffFileRules,
  diffFileRulesFromT3ProjectFile,
  isHiddenDiffFile,
  applyDiffFileOrder,
} from "./diffFileRules.ts";

describe("isHiddenDiffFile", () => {
  const rules = compileDiffFileRules({
    hiddenFiles: [
      "bun.lock",
      "**/*.snap",
      "generated/",
      "/docs/*.md",
      "apps/web/src/routeTree.gen.ts",
      "**/package.json",
      "!/package.json",
      "!apps/web/test/keep.test.ts",
      "[",
    ],
  });

  it.each([
    ["bun.lock", true],
    ["apps/web/bun.lock", true],
    ["src/__snapshots__/a.snap", true],
    ["packages/shared/generated/api.ts", true],
    ["generated", false],
    ["docs/intro.md", true],
    ["apps/docs/intro.md", false],
    ["docs/guide/intro.md", false],
    ["apps/web/src/routeTree.gen.ts", true],
    ["apps/web/package.json", true],
    ["package.json", false],
    ["apps/web/src/app.test.ts", true],
    ["apps/web/test/keep.test.ts", false],
    ["apps/web/src/app.ts", false],
  ] as const)("%s hidden: %s", (path, hidden) => {
    expect(isHiddenDiffFile(rules, path)).toBe(hidden);
  });

  it("hides only test files without configuration", () => {
    expect(isHiddenDiffFile(BUILT_IN_DIFF_FILE_RULES, "src/a.test.ts")).toBe(true);
    expect(isHiddenDiffFile(BUILT_IN_DIFF_FILE_RULES, "bun.lock")).toBe(false);
  });
});

describe("applyDiffFileOrder", () => {
  const order = (sort: Record<string, ReadonlyArray<string>>, paths: ReadonlyArray<string>) =>
    applyDiffFileOrder(compileDiffFileRules({ sort }), paths, (path) => path);

  it("ranks listed children first per matching folder and keeps the rest in arrival order", () => {
    expect(
      order(
        {
          ".": ["packages", "apps"],
          "packages/*": ["use-cases", "server"],
          "packages/**/src": ["*.model.ts", "*.errors.ts"],
        },
        [
          "apps/web/main.ts",
          "bun.lock",
          "packages/billing/server/src/invoice.http.ts",
          "packages/billing/use-cases/src/invoice.errors.ts",
          "packages/billing/use-cases/src/invoice.model.ts",
          "packages/billing/use-cases/src/invoice.service.ts",
          "packages/billing/ui/view.ts",
        ],
      ),
    ).toEqual([
      "packages/billing/use-cases/src/invoice.model.ts",
      "packages/billing/use-cases/src/invoice.errors.ts",
      "packages/billing/use-cases/src/invoice.service.ts",
      "packages/billing/server/src/invoice.http.ts",
      "packages/billing/ui/view.ts",
      "apps/web/main.ts",
      "bun.lock",
    ]);
  });

  it("matches dot folders, and an empty list still claims its folder", () => {
    expect(order({ ".github": ["z.yml"] }, [".github/a.yml", ".github/z.yml"])).toEqual([
      ".github/z.yml",
      ".github/a.yml",
    ]);
    expect(order({ src: [], "**": ["z.ts"] }, ["src/a.ts", "src/z.ts"])).toEqual([
      "src/a.ts",
      "src/z.ts",
    ]);
  });

  it("returns the same list when nothing is configured", () => {
    const paths = ["b.ts", "a.ts"];
    expect(applyDiffFileOrder(BUILT_IN_DIFF_FILE_RULES, paths, (path) => path)).toBe(paths);
  });
});

describe("diffFileRulesFromT3ProjectFile", () => {
  it("reads rules from t3.json and falls back to built-in rules", () => {
    const rules = diffFileRulesFromT3ProjectFile('{ "diff": { "hiddenFiles": ["bun.lock"] } }');
    expect(isHiddenDiffFile(rules, "bun.lock")).toBe(true);
    expect(diffFileRulesFromT3ProjectFile("{}")).toBe(BUILT_IN_DIFF_FILE_RULES);
    expect(diffFileRulesFromT3ProjectFile(null)).toBe(BUILT_IN_DIFF_FILE_RULES);
  });
});
