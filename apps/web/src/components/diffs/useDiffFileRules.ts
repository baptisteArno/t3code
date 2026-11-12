import { type EnvironmentId, T3_PROJECT_FILE_NAME } from "@t3tools/contracts";
import { diffFileRulesFromT3ProjectFile } from "@t3tools/shared/diffFileRules";

import { useFilesystemReadAccess } from "~/state/filesystem";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";

/** The hidden-file patterns and folder order a checkout's t3.json sets for its diffs. */
export function useDiffFileRules(environmentId: EnvironmentId | null, cwd: string | null) {
  const { canReadFiles } = useFilesystemReadAccess(environmentId);
  const query = useEnvironmentQuery(
    environmentId !== null && cwd !== null && canReadFiles
      ? projectEnvironment.readFile({
          environmentId,
          input: { cwd, relativePath: T3_PROJECT_FILE_NAME, allowMissing: true },
        })
      : null,
  );
  const data = query.data;
  return diffFileRulesFromT3ProjectFile(
    data && data.exists !== false && !data.truncated ? data.contents : null,
  );
}
