import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { resolveNextThreadAfterSend } from "./threadListV2";

type InboxThread = Pick<EnvironmentThreadShell, "environmentId" | "id">;

type InboxSource = (sentThreadKey: string) => InboxThread | null;

const inboxSources = new Set<InboxSource>();

/** Offers a mounted thread list's inbox to the next send while the setting is on. */
export function useNextThreadAfterSendSource(input: {
  readonly enabled: boolean;
  readonly inboxThreads: ReadonlyArray<InboxThread>;
  readonly loadedEnvironmentIds: ReadonlySet<EnvironmentId>;
}) {
  const { enabled, inboxThreads, loadedEnvironmentIds } = input;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this list's inbox in the module-level next-thread-after-send registry
  useEffect(() => {
    if (!enabled) return;
    const source: InboxSource = (sentThreadKey) =>
      resolveNextThreadAfterSend({ inboxThreads, sentThreadKey, loadedEnvironmentIds });
    inboxSources.add(source);
    return () => {
      inboxSources.delete(source);
    };
  }, [enabled, inboxThreads, loadedEnvironmentIds]);
}

/**
 * Opens the top inbox thread after a send, or a new thread in the sent thread's project when the
 * inbox is empty. Returns false, leaving the user where they are, when no list offers its inbox.
 */
export function useAdvanceAfterSend() {
  const selectDetail = useSelectWorkspaceDetail();
  return (sent: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
  }): boolean => {
    const source = [...inboxSources].at(-1);
    if (source === undefined) return false;
    const next = source(scopedThreadKey(sent.environmentId, sent.threadId));
    selectDetail({
      name: "Thread",
      params:
        next === null
          ? {
              draft: {
                requestId: uuidv4(),
                environmentId: String(sent.environmentId),
                projectId: String(sent.projectId),
              },
            }
          : { environmentId: String(next.environmentId), threadId: String(next.id) },
    });
    return true;
  };
}
