import {
  applyDiffFileOrder,
  type DiffFileRules,
  isHiddenDiffFile,
} from "@t3tools/shared/diffFileRules";
import type { ReviewParsedDiff } from "../review/reviewModel";

/** Orders by t3.json and, while hiding, drops what it and the test detection hide. */
export function visibleDiffFiles<T extends { readonly path: string }>(
  items: ReadonlyArray<T>,
  rules: DiffFileRules,
  hideFiles: boolean,
  includePath?: string,
): ReadonlyArray<T> {
  const ordered = applyDiffFileOrder(rules, items, (item) => item.path);
  if (!hideFiles) return ordered;
  const shown = ordered.filter(
    (item) => item.path === includePath || !isHiddenDiffFile(rules, item.path),
  );
  return shown.length === ordered.length ? ordered : shown;
}

export function filterPullRequestFiles(
  parsed: ReviewParsedDiff,
  rules: DiffFileRules,
  hideFiles: boolean,
  includePath?: string,
): ReviewParsedDiff {
  if (parsed.kind !== "files") return parsed;
  const files = visibleDiffFiles(parsed.files, rules, hideFiles, includePath);
  if (files === parsed.files) return parsed;
  if (files.length === parsed.files.length) return { ...parsed, files };
  return {
    ...parsed,
    files,
    fileCount: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  };
}

/** Patches to load around `index` (or from the top): the next three files the review will show. */
export function shownPatchIndices(
  files: ReadonlyArray<{ readonly path: string }>,
  rules: DiffFileRules,
  hideFiles: boolean,
  index: number | null,
  includePath?: string,
): ReadonlyArray<number> {
  const shown = visibleDiffFiles(
    files.map((file, position) => ({ path: file.path, position })),
    rules,
    hideFiles,
    includePath,
  ).map((file) => file.position);
  if (index === null) return shown.slice(0, 3);
  const position = shown.indexOf(index);
  return position < 0 ? [index] : shown.slice(position, position + 3);
}
