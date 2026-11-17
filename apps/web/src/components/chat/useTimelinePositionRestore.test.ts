import { describe, expect, it, vi } from "vite-plus/test";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  measuredEndOffset,
  resolveTimelineOpening,
  settleListScroll,
} from "./useTimelinePositionRestore";

describe("resolveTimelineOpening", () => {
  const row = (id: string, role: "user" | "assistant") =>
    ({ id, kind: "message", message: { role } }) as MessagesTimelineRow;
  const rows = [
    row("ask", "user"),
    row("reply", "assistant"),
    row("again", "user"),
    row("end", "assistant"),
  ];
  const history = { rowId: "reply", offsetWithinRow: 0, scrollOffset: 0, atEnd: false };

  it.each([
    [
      "the reader's place in history",
      history,
      rows,
      false,
      true,
      { kind: "remembered", position: history },
    ],
    ["the latest prompt", undefined, rows, false, true, { kind: "latestPrompt", rowId: "again" }],
    [
      "the latest prompt when left at the end",
      { ...history, atEnd: true },
      rows,
      false,
      false,
      { kind: "latestPrompt", rowId: "again" },
    ],
    ["the end when a sent turn is anchored", undefined, rows, true, true, { kind: "end" }],
    [
      "an earlier page when no loaded row is a prompt",
      undefined,
      [row("end", "assistant")],
      false,
      true,
      { kind: "earlierPrompt" },
    ],
    [
      "the end without a prompt",
      undefined,
      [row("end", "assistant")],
      false,
      false,
      { kind: "end" },
    ],
  ] as const)("opens on %s", (_, remembered, timelineRows, anchored, canLoadEarlier, expected) => {
    expect(resolveTimelineOpening(remembered, timelineRows, anchored, canLoadEarlier)).toEqual(
      expected,
    );
  });
});

describe("settleListScroll", () => {
  it("hands off when a streaming reply keeps moving the end", async () => {
    vi.useFakeTimers();
    // The node test environment has no animation frames; fake ones run on the fake clock.
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 16),
    );
    // Every correction lands, then the reply grows before the next frame.
    const element = { scrollTop: 0, scrollHeight: 5_000, clientHeight: 800 };
    const list = {
      getScrollableNode: () => element as unknown as HTMLElement,
      scrollToOffset: async ({ offset }: { offset: number }) => {
        element.scrollTop = offset;
        element.scrollHeight += 40;
      },
    };

    let settled = false;
    void settleListScroll(list, measuredEndOffset, () => false).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();
    vi.unstubAllGlobals();

    expect(settled).toBe(true);
  });
});
