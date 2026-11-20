import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { effectiveSnoozed, type SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import type { SnoozePresetSetting } from "@t3tools/contracts/settings";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";

import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import * as Dialog from "../../components/ui/Dialog";
import { useNowMinuteMs } from "../../lib/clock";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import { useThreadListActions } from "../home/useThreadListActions";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import { useAdvancingParkActions } from "./nextThreadAfterSend";
import {
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozePresets,
} from "./threadListV2";

// Reads the clock when the item is picked: the menu was built up to a minute earlier.
function selectSnoozePreset(
  presetId: string,
  presets: ReadonlyArray<SnoozePreset>,
  settings: ReadonlyArray<SnoozePresetSetting> | undefined,
) {
  return resolveThreadListV2SnoozeMenuSelection({
    event: `snooze:${presetId}`,
    displayedPresets: presets,
    now: new Date(),
    presets: settings,
  });
}

/** Diff, Settle and Snooze in place of upstream's Files, Git and Terminal (fork-only). */
export function useThreadStateButtons(thread: EnvironmentThreadShell | null, canReview: boolean) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const listActions = useThreadListActions();
  const { unsettleThread, unsnoozeThread } = listActions;
  const { settleThread, snoozeThread } = useAdvancingParkActions(listActions);
  const { snoozePresetsByEnvironmentId } = useAtomValue(threadListEnvironmentsAtom);
  const now = new Date(useNowMinuteMs()).toISOString();
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  if (!thread) return null;

  const settled = thread.settledOverride === "settled";
  const snoozed = effectiveSnoozed(thread, { now });
  const presetSettings = snoozePresetsByEnvironmentId.get(thread.environmentId);
  const presets = resolveThreadListV2SnoozePresets(
    { secondary: "snooze", now, presets: presetSettings },
    m,
  );
  const snooze = (presetId: string) => {
    const selection = selectSnoozePreset(presetId, presets, presetSettings);
    if (selection._tag === "selected") void snoozeThread(thread, selection.preset.snoozedUntil);
    else
      Dialog.alert(
        gt("Could not snooze thread"),
        gt("That snooze time has passed. Choose another time."),
      );
  };
  const actions: AppBarAction[] = [
    {
      accessibilityLabel: gt("Review changes"),
      icon: "plusminus",
      disabled: !canReview,
      separateBackground: false,
      onPress: () =>
        navigation.navigate("ThreadReview", {
          environmentId: thread.environmentId,
          threadId: thread.id,
        }),
    },
    {
      accessibilityLabel: settled
        ? gt("Un-settle", { $context: "verb, thread action" })
        : gt("Settle", { $context: "verb, thread action" }),
      icon: "checkmark.circle",
      selected: settled,
      separateBackground: false,
      onPress: () => void (settled ? unsettleThread(thread) : settleThread(thread)),
    },
  ];
  const menus: AppBarMenu[] = [
    {
      title: gt("Snooze", { $context: "verb, thread action" }),
      icon: "clock",
      separateBackground: false,
      items: snoozed
        ? [
            {
              id: "unsnooze",
              title: gt("Wake now"),
              icon: "alarm",
              onPress: () => void unsnoozeThread(thread),
            },
          ]
        : [
            ...presets.map((preset) => ({
              id: `snooze:${preset.id}`,
              title: preset.label,
              subtitle: preset.whenLabel,
              onPress: () => snooze(preset.id),
            })),
            {
              id: "snooze:custom",
              title: gt("Custom…", { $context: "custom snooze time" }),
              onPress: () => setCustomSnoozeOpen(true),
            },
          ],
    },
  ];
  const sheet = customSnoozeOpen ? (
    <CustomSnoozeSheet
      onClose={() => setCustomSnoozeOpen(false)}
      onSnooze={(snoozedUntil) => void snoozeThread(thread, snoozedUntil)}
    />
  ) : null;
  return { actions, menus, sheet };
}
