import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { diffFileRulesFromT3ProjectFile } from "@t3tools/shared/diffFileRules";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";
import type { ReviewParsedDiff } from "../review/reviewModel";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useT3ProjectFileContents } from "../../state/t3-project-file";
import { useAtomCommand } from "../../state/use-atom-command";
import { filterPullRequestFiles } from "./pullRequestFileFilters";

/** Hides and orders files by the built-in test detection and the checkout's t3.json. */
export function usePullRequestFileFilter(
  parsed: ReviewParsedDiff,
  checkout: { readonly environmentId: string; readonly workspaceRoot: string | null },
  includePath?: string,
) {
  const rules = diffFileRulesFromT3ProjectFile(
    useT3ProjectFileContents(EnvironmentId.make(checkout.environmentId), checkout.workspaceRoot)
      .contents,
  );
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const hideTestFiles =
    AsyncResult.isSuccess(preferences) && preferences.value.pullRequestHideTestFiles === true;
  const visible = useMemo(
    () => filterPullRequestFiles(parsed, rules, hideTestFiles, includePath),
    [parsed, rules, hideTestFiles, includePath],
  );
  const hiddenCount =
    parsed.kind === "files" && visible.kind === "files" ? parsed.fileCount - visible.fileCount : 0;
  return {
    parsed: visible,
    hideTestFiles,
    hiddenCount,
    rules,
    toggle: () => {
      void savePreferences({ pullRequestHideTestFiles: !hideTestFiles });
    },
    showAll: () => {
      void savePreferences({ pullRequestHideTestFiles: false });
    },
  };
}
