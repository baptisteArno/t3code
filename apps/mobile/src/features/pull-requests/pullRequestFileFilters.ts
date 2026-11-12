import {
  applyDiffFileOrder,
  type DiffFileRules,
  isHiddenDiffFile,
} from "@t3tools/shared/diffFileRules";
import type { ReviewParsedDiff } from "../review/reviewModel";

export function filterPullRequestFiles(
  parsed: ReviewParsedDiff,
  rules: DiffFileRules,
  hideFiles: boolean,
  includePath?: string,
): ReviewParsedDiff {
  if (parsed.kind !== "files") return parsed;
  const ordered = applyDiffFileOrder(rules, parsed.files, (file) => file.path);
  const shown = hideFiles
    ? ordered.filter((file) => file.path === includePath || !isHiddenDiffFile(rules, file.path))
    : ordered;
  const files = shown.length === ordered.length ? ordered : shown;
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
