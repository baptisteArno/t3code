import type { LegendListRef } from "@legendapp/list/react";
import { CHAT_LIST_ANCHOR_OFFSET } from "@t3tools/shared/chatList";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { RememberedTimelinePosition } from "./timelineScrollAnchoring";
import type { TimelineViewport } from "./timelineViewport";

// A streaming reply moves the end every frame, so the target may never hold
// still. Past this many frames the list's own end maintenance takes over.
const SETTLE_MAX_FRAMES = 60;

/**
 * Index and end scrolling start from estimated row sizes, so they can stop
 * short of a tall row. Corrects against the DOM until the viewport holds the
 * target for two layout frames, the frame budget runs out, the caller cancels,
 * or the target disappears.
 */
export function settleListScroll(
  list: Pick<LegendListRef, "getScrollableNode" | "scrollToOffset">,
  target: (element: HTMLElement) => number | undefined,
  isCancelled: () => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    let stableFrames = 0;
    let frames = 0;
    const reconcile = () => {
      if (isCancelled()) return resolve();
      const element = list.getScrollableNode();
      const offset = element ? target(element) : undefined;
      frames += 1;
      if (!element || offset === undefined || frames > SETTLE_MAX_FRAMES) return resolve();
      if (Math.abs(element.scrollTop - offset) > 1) {
        stableFrames = 0;
        void list.scrollToOffset({ offset, animated: false }).then(() => {
          requestAnimationFrame(reconcile);
        });
        return;
      }
      stableFrames += 1;
      if (stableFrames >= 2) resolve();
      else requestAnimationFrame(reconcile);
    };
    requestAnimationFrame(reconcile);
  });
}

export const measuredEndOffset = (element: HTMLElement) =>
  element.scrollHeight - element.clientHeight;

export type TimelineOpening =
  | { readonly kind: "remembered"; readonly position: RememberedTimelinePosition }
  | { readonly kind: "latestPrompt"; readonly rowId: string }
  | { readonly kind: "end" };

/**
 * Where a newly shown thread opens: where the reader left it in history, else
 * with its latest prompt at the top so the reply starts in view, else at its
 * end. A turn the reader just sent is anchored by follow instead.
 */
export function resolveTimelineOpening(
  rememberedPosition: RememberedTimelinePosition | undefined,
  rows: ReadonlyArray<MessagesTimelineRow>,
  newTurnAnchored: boolean,
): TimelineOpening {
  if (rememberedPosition?.atEnd === false) {
    return { kind: "remembered", position: rememberedPosition };
  }
  if (newTurnAnchored) return { kind: "end" };
  const prompt = rows.findLast((row) => row.kind === "message" && row.message.role === "user");
  return prompt ? { kind: "latestPrompt", rowId: prompt.id } : { kind: "end" };
}

/**
 * Scrolls a newly shown thread to its opening (see resolveTimelineOpening)
 * and reports the thread positioned once the target row settles, saying
 * whether it rests on the latest prompt. Any navigation on the viewport
 * cancels it where it is. Returns the cancel for the operation's owner.
 */
export function startTimelinePositionRestore({
  list,
  viewport,
  listIdentityKey,
  listOpenedOn,
  rememberedPosition,
  newTurnAnchored,
  citationPending,
  releaseForFind,
  onPositioned,
}: {
  readonly list: LegendListRef;
  readonly viewport: TimelineViewport;
  readonly listIdentityKey: string;
  /** The identity the mounted list opened on, until it shows another; see nextListOpening. */
  readonly listOpenedOn: string | null;
  readonly rememberedPosition: RememberedTimelinePosition | undefined;
  readonly newTurnAnchored: boolean;
  readonly citationPending: boolean;
  /**
   * Find was open when the list started showing the thread. Opening find is
   * navigation, so follow lets go; the thread still opens where it was left,
   * and MessagesTimeline holds find's reveal until this reports it positioned.
   */
  readonly releaseForFind: boolean;
  readonly onPositioned: (identity: string, onLatestPrompt: boolean) => void;
}): () => void {
  if (citationPending) {
    // The citation scroll owns positioning once the list has mounted.
    onPositioned(listIdentityKey, false);
    return () => {};
  }
  let cancelled = false;
  const rows = list.getState().data as ReadonlyArray<MessagesTimelineRow>;
  const opening = resolveTimelineOpening(rememberedPosition, rows, newTurnAnchored);
  const target =
    opening.kind === "remembered"
      ? opening.position
      : opening.kind === "latestPrompt"
        ? { rowId: opening.rowId, offsetWithinRow: -CHAT_LIST_ANCHOR_OFFSET }
        : null;
  const index = target ? rows.findIndex((row) => row.id === target.rowId) : -1;
  // Opening above the end or finding: follow lets go before the restore claims
  // the viewport, so a running turn streams below without pulling the view.
  if (target || releaseForFind) viewport.navigate({ releasesFollow: true });
  const releaseScrollHold = viewport.holdProgrammaticScroll();
  const stop = () => {
    cancelled = true;
    releaseScrollHold();
    unsubscribe();
  };
  const unsubscribe = viewport.subscribe(() => {
    if (cancelled) return;
    stop();
    void list.scrollToOffset({ offset: viewport.scrollNode.scrollTop, animated: false });
    onPositioned(listIdentityKey, false);
  });
  const finish = () => {
    stop();
    onPositioned(listIdentityKey, opening.kind === "latestPrompt");
  };
  const scrolling = target
    ? index >= 0
      ? list.scrollToIndex({
          index,
          animated: false,
          viewPosition: 0,
          viewOffset: -target.offsetWithinRow,
        })
      : opening.kind === "remembered"
        ? list.scrollToOffset({ offset: opening.position.scrollOffset, animated: false })
        : undefined
    : // initialScrollAtEnd measured this target; scrollToEnd would replace it with an estimate.
      listOpenedOn === listIdentityKey
      ? undefined
      : list.scrollToEnd({ animated: false });
  const settlesAtEnd = target === null && scrolling !== undefined;
  void Promise.resolve(scrolling).then(async () => {
    if (cancelled) return;
    if (settlesAtEnd) {
      await settleListScroll(list, measuredEndOffset, () => cancelled);
    } else if (target && index >= 0) {
      // Keep the saved row mounted until its measured position and the DOM agree.
      await settleListScroll(
        list,
        (element) => {
          const state = list.getState();
          const rowIndex = state.indexByKey(target.rowId);
          const row = rowIndex === undefined ? undefined : state.elementAtIndex(rowIndex);
          if (!row) return undefined;
          return Math.max(
            0,
            Math.min(
              element.scrollTop +
                row.getBoundingClientRect().top -
                element.getBoundingClientRect().top +
                target.offsetWithinRow,
              measuredEndOffset(element),
            ),
          );
        },
        () => cancelled,
      );
    }
    if (!cancelled) finish();
  });
  return stop;
}
