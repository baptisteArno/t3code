import { AuthFilesystemReadScope, type ScopedThreadRef } from "@t3tools/contracts";

import { openFileInDiff, resolveDiffPathForWorkspace } from "../diffFileActions";
import { selectThreadBranchBaseRef, useDiffPanelStore } from "../diffPanelStore";
import { readProject, readThreadShell } from "../state/entities";
import { reviewEnvironment } from "../state/review";
import { readEnvironmentScope } from "../state/session";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { getClientSettings } from "./useSettings";

/** Opens a workspace file in the Diff pane when the branch comparison changes it, else `openFile`. */
export function useOpenFileWithDiff() {
  const readDiffPreview = useAtomQueryRunner(reviewEnvironment.diffPreview, {
    reportFailure: false,
  });
  return async (
    threadRef: ScopedThreadRef,
    workspacePath: string,
    openFile: () => void,
    isCurrent: () => boolean,
  ) => {
    const thread = readThreadShell(threadRef);
    const project = thread
      ? readProject({ environmentId: threadRef.environmentId, projectId: thread.projectId })
      : null;
    const cwd = thread?.worktreePath ?? project?.workspaceRoot;
    if (!cwd || !readEnvironmentScope(threadRef.environmentId, AuthFilesystemReadScope)) {
      openFile();
      return;
    }
    const baseRef = selectThreadBranchBaseRef(useDiffPanelStore.getState(), threadRef);
    // The Diff pane's branch comparison input, so a pane that already loaded it answers from cache.
    const result = await readDiffPreview({
      environmentId: threadRef.environmentId,
      input: {
        cwd,
        ...(baseRef ? { baseRef } : {}),
        ignoreWhitespace: getClientSettings().diffIgnoreWhitespace,
        metadataOnly: true,
        sourceKind: "branch-range",
      },
    });
    if (!isCurrent()) return;
    const repositoryRoot = thread?.worktreePath ? undefined : project?.repositoryIdentity?.rootPath;
    const changed =
      result._tag === "Success" &&
      result.value.sources.some(
        (source) =>
          source.kind === "branch-range" &&
          source.files?.some(
            (file) =>
              resolveDiffPathForWorkspace({
                filePath: file.path,
                workspaceRoot: cwd,
                repositoryRoot,
              }) === workspacePath,
          ),
      );
    if (changed) openFileInDiff(threadRef, workspacePath);
    else openFile();
  };
}
