import type { ReviewDiffPreviewSource } from "@t3tools/contracts";
import {
  isWindowsAbsolutePath,
  resolveWorkspaceFilePath,
  workspaceRelativeFilePath,
} from "@t3tools/shared/path";

function comparablePath(path: string, caseInsensitive: boolean): string | null {
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;
  const joined = segments.join("/");
  return caseInsensitive ? joined.toLowerCase() : joined;
}

/**
 * The branch comparison's own path for a workspace file it changes, or null. Diff paths are
 * relative to the repository root, which is above the workspace when a project is a subfolder.
 */
export function findBranchChangedFilePath(input: {
  readonly sources: ReadonlyArray<ReviewDiffPreviewSource>;
  readonly workspacePath: string;
  readonly workspaceRoot: string;
  readonly repositoryRoot?: string | undefined;
}): string | null {
  const files = input.sources.find((source) => source.kind === "branch-range")?.files;
  if (!files) return null;
  const repositoryRoot = input.repositoryRoot ?? input.workspaceRoot;
  const repositoryPath = workspaceRelativeFilePath(
    resolveWorkspaceFilePath(input.workspacePath, input.workspaceRoot),
    repositoryRoot,
  );
  const caseInsensitive = isWindowsAbsolutePath(repositoryRoot);
  const target = repositoryPath === null ? null : comparablePath(repositoryPath, caseInsensitive);
  if (target === null) return null;
  return files.find((file) => comparablePath(file.path, caseInsensitive) === target)?.path ?? null;
}
