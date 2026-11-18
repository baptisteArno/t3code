import { describe, expect, it } from "vite-plus/test";

import { flattenReviewFileTree, reviewFileStatus, type ReviewTreeFile } from "./reviewFileTreeRows";

const file = (path: string, status: ReviewTreeFile["status"] = "modified"): ReviewTreeFile => ({
  id: `id:${path}`,
  path,
  status,
  additions: 1,
  deletions: 0,
});

const outline = (rows: ReturnType<typeof flattenReviewFileTree>) =>
  rows.map((row) =>
    row.kind === "directory"
      ? `${"  ".repeat(row.depth)}${row.name}/${row.collapsed ? " (collapsed)" : ""}`
      : `${"  ".repeat(row.depth)}${row.name} ${row.file.status}`,
  );

describe("flattenReviewFileTree", () => {
  const files = [
    file("apps/mobile/src/review/ReviewSheet.tsx"),
    file("apps/mobile/src/review/reviewFileTree.ts", "added"),
    file("README.md"),
    file("apps/mobile/src/lib/theme.ts", "deleted"),
    file("packages/shared/src/themes.ts", "renamed"),
  ];

  it("compacts single-child directories and keeps the diff's order", () => {
    expect(outline(flattenReviewFileTree(files, new Set()))).toEqual([
      "apps/mobile/src/",
      "  review/",
      "    ReviewSheet.tsx modified",
      "    reviewFileTree.ts added",
      "  lib/",
      "    theme.ts deleted",
      "README.md modified",
      "packages/shared/src/",
      "  themes.ts renamed",
    ]);
  });

  it("hides a collapsed directory's contents by its full path", () => {
    expect(outline(flattenReviewFileTree(files, new Set(["apps/mobile/src/review/"])))).toEqual([
      "apps/mobile/src/",
      "  review/ (collapsed)",
      "  lib/",
      "    theme.ts deleted",
      "README.md modified",
      "packages/shared/src/",
      "  themes.ts renamed",
    ]);
  });
});

it.each([
  ["new", "added"],
  ["deleted", "deleted"],
  ["rename-pure", "renamed"],
  ["rename-changed", "renamed"],
  ["change", "modified"],
] as const)("maps a %s file to %s", (changeType, status) => {
  expect(reviewFileStatus(changeType)).toBe(status);
});
