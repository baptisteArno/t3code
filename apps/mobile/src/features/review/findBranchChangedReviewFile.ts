import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { findBranchChangedFilePath } from "@t3tools/client-runtime/review-changed-file";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { AuthFilesystemReadScope, type EnvironmentId, type ThreadId } from "@t3tools/contracts";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects } from "../../state/projects";
import { reviewEnvironment } from "../../state/review";
import { readEnvironmentScope } from "../../state/session";
import { environmentThreadShells } from "../../state/threads";

/** The diff path of a workspace file the thread's branch comparison changes, else null. */
export async function findBranchChangedReviewFile(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly workspacePath: string;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  if (!readEnvironmentScope(input.environmentId, AuthFilesystemReadScope)) return null;
  // File stats only: an unchanged file then costs no patch transfer.
  const result = await executeAtomQuery(
    appAtomRegistry,
    reviewEnvironment.diffPreview({
      environmentId: input.environmentId,
      input: { cwd: input.cwd, metadataOnly: true, sourceKind: "branch-range" },
    }),
    { signal: input.signal, reportFailure: false, reportDefect: false },
  );
  if (result._tag !== "Success") return null;
  const thread = appAtomRegistry.get(
    environmentThreadShells.threadShellAtom(scopeThreadRef(input.environmentId, input.threadId)),
  );
  const project = thread
    ? appAtomRegistry.get(
        environmentProjects.projectAtom({
          environmentId: input.environmentId,
          projectId: thread.projectId,
        }),
      )
    : null;
  // A worktree cwd is its repository's root; a project folder can sit below it.
  const repositoryRoot =
    project && input.cwd === project.workspaceRoot
      ? project.repositoryIdentity?.rootPath
      : undefined;
  return findBranchChangedFilePath({
    sources: result.value.sources,
    workspacePath: input.workspacePath,
    workspaceRoot: input.cwd,
    repositoryRoot,
  });
}
