import type { ReviewDiffPreviewSource } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findBranchChangedFilePath } from "./reviewChangedFile.ts";

function source(
  kind: ReviewDiffPreviewSource["kind"],
  paths: ReadonlyArray<string> | undefined,
): ReviewDiffPreviewSource {
  return {
    id: kind,
    kind,
    title: kind,
    baseRef: null,
    headRef: null,
    diff: "",
    diffHash: `${kind}-hash`,
    truncated: false,
    ...(paths
      ? {
          files: paths.map((path) => ({ path, previousPath: null, additions: 1, deletions: 0 })),
        }
      : {}),
  };
}

describe("findBranchChangedFilePath", () => {
  it.each([
    {
      name: "a file at the repository root",
      sources: [source("branch-range", ["src/app.ts"])],
      workspacePath: "./src/app.ts",
      workspaceRoot: "/repo",
      repositoryRoot: undefined,
      expected: "src/app.ts",
    },
    {
      name: "a file in a project that is a subfolder of its repository",
      sources: [source("branch-range", ["apps/web/src/app.ts", "src/app.ts"])],
      workspacePath: "src/app.ts",
      workspaceRoot: "/repo/apps/web",
      repositoryRoot: "/repo",
      expected: "apps/web/src/app.ts",
    },
    {
      name: "a file only the uncommitted comparison lists",
      sources: [source("working-tree", ["src/app.ts"]), source("branch-range", [])],
      workspacePath: "src/app.ts",
      workspaceRoot: "/repo",
      repositoryRoot: undefined,
      expected: null,
    },
    {
      name: "a comparison without file stats",
      sources: [source("branch-range", undefined)],
      workspacePath: "src/app.ts",
      workspaceRoot: "/repo",
      repositoryRoot: undefined,
      expected: null,
    },
    {
      name: "a path that leaves the repository",
      sources: [source("branch-range", ["other/app.ts"])],
      workspacePath: "../other/app.ts",
      workspaceRoot: "/repo",
      repositoryRoot: undefined,
      expected: null,
    },
    {
      name: "a Windows repository, whatever the case",
      sources: [source("branch-range", ["Pkg/Src/App.ts"])],
      workspacePath: "src/app.ts",
      workspaceRoot: "C:\\repo\\pkg",
      repositoryRoot: "C:\\Repo",
      expected: "Pkg/Src/App.ts",
    },
  ])("matches $name", ({ sources, workspacePath, workspaceRoot, repositoryRoot, expected }) => {
    expect(
      findBranchChangedFilePath({ sources, workspacePath, workspaceRoot, repositoryRoot }),
    ).toBe(expected);
  });
});
