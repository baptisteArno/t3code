import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import {
  type EnvironmentId,
  type ProjectReadFileResult,
  T3_PROJECT_FILE_NAME,
} from "@t3tools/contracts";

import { useEnvironmentPresentation } from "./presentation";
import { projectEnvironment } from "./projects";
import { useEnvironmentQuery } from "./query";
import { environmentSession } from "./session";

/** A checkout's t3.json contents, or null while unreadable, missing or truncated. */
export function useT3ProjectFileContents(environmentId: EnvironmentId | null, cwd: string | null) {
  const hasWorkspace = environmentId !== null && cwd !== null && cwd !== "";
  const session = useEnvironmentQuery(
    hasWorkspace ? environmentSession.sessionStateAtom(environmentId) : null,
  );
  const environment = useEnvironmentPresentation(environmentId);
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: environment.isReady,
    connection: environment.presentation?.connection ?? null,
    session: session.data,
    sessionError: session.error,
  });
  const query = useEnvironmentQuery(
    fileAccess.canReadFiles && hasWorkspace
      ? projectEnvironment.readFile({
          environmentId,
          input: { cwd, relativePath: T3_PROJECT_FILE_NAME, allowMissing: true },
        })
      : null,
  );
  const data = query.data as ProjectReadFileResult | null;
  return {
    contents: data === null || data.exists === false || data.truncated ? null : data.contents,
    isPending: hasWorkspace && (fileAccess.isPending || query.isPending),
  };
}
