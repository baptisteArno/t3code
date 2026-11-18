import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { LegendList } from "@legendapp/list/react-native";
import { useGT } from "gt-react-native";
import { useState, type ReactElement } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { cn } from "../../lib/cn";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  flattenReviewFileTree,
  type ReviewFileStatus,
  type ReviewTreeFile,
  type ReviewTreeRow,
} from "./reviewFileTreeRows";

// The web diff tree's (@pierre/trees) git status colors and letters.
const STATUS_COLORS: Readonly<Record<"light" | "dark", Record<ReviewFileStatus, string>>> = {
  light: { added: "#16a994", modified: "#1ca1c7", deleted: "#ff2e3f", renamed: "#d5a910" },
  dark: { added: "#00cab1", modified: "#08c0ef", deleted: "#ff6762", renamed: "#ffd452" },
};
const STATUS_LETTERS: Readonly<Record<ReviewFileStatus, string>> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};
const ROW_HEIGHT = 34;
const INDENT = 14;

function ReviewFileTreeRow(props: {
  readonly row: ReviewTreeRow;
  readonly selected: boolean;
  readonly statusColors: Record<ReviewFileStatus, string>;
  readonly onToggleDirectory: (path: string) => void;
  readonly onSelectFile: (fileId: string) => void;
}) {
  const { row } = props;
  const gt = useGT();
  const paddingLeft = 8 + row.depth * INDENT;

  if (row.kind === "directory") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={row.name}
        accessibilityState={{ expanded: !row.collapsed }}
        onPress={() => props.onToggleDirectory(row.path)}
        className="mx-2 flex-row items-center gap-1.5 rounded-[10px] pr-2 active:bg-subtle"
        style={{ height: ROW_HEIGHT, paddingLeft }}
      >
        <SymbolView
          name={row.collapsed ? "chevron.right" : "chevron.down"}
          size={10}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
        <PierreEntryIcon path={row.path} kind="directory" size={15} />
        <Text
          className="min-w-0 flex-1 text-sm font-t3-medium text-foreground-secondary"
          numberOfLines={1}
          ellipsizeMode="head"
        >
          {row.name}
        </Text>
      </Pressable>
    );
  }

  const { file } = row;
  const color = props.statusColors[file.status];
  const statusLabel = {
    added: gt("Added"),
    modified: gt("Modified"),
    deleted: gt("Deleted"),
    renamed: gt("Renamed"),
  }[file.status];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${file.path}, ${statusLabel}, +${file.additions}, -${file.deletions}`}
      accessibilityState={{ selected: props.selected }}
      onPress={() => props.onSelectFile(file.id)}
      className={cn(
        "mx-2 flex-row items-center gap-1.5 rounded-[10px] pr-2 active:bg-subtle",
        props.selected && "bg-thread-selected",
      )}
      style={{ height: ROW_HEIGHT, paddingLeft: paddingLeft + 10 + 6 }}
    >
      <PierreEntryIcon path={file.path} kind="file" size={15} />
      <Text
        className={cn("min-w-0 flex-1 text-sm", props.selected ? "font-t3-bold" : "font-t3-medium")}
        style={{ color }}
        numberOfLines={1}
      >
        {row.name}
      </Text>
      <Text className="text-2xs font-t3-bold text-adaptive-emerald-700-300">
        +{formatDiffCount(file.additions)}
      </Text>
      <Text className="text-2xs font-t3-bold text-adaptive-rose-700-300">
        -{formatDiffCount(file.deletions)}
      </Text>
      <Text className="w-3 text-center text-xs font-t3-bold" style={{ color }}>
        {STATUS_LETTERS[file.status]}
      </Text>
    </Pressable>
  );
}

/** The changed files as a tree, each with its git status, like the web diff panel's tree. */
export function ReviewFileTree(props: {
  readonly files: ReadonlyArray<ReviewTreeFile>;
  readonly selectedFileId: string | null;
  readonly onSelectFile: (fileId: string) => void;
  /** Full-screen use: the bar insets the list sits under. Without it, the pane adjusts itself. */
  readonly contentInset?: { readonly top: number; readonly bottom: number };
  readonly refreshControl?: ReactElement;
  /** A new value remounts the list alone, keeping the collapsed folders. */
  readonly listKey?: number;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const rows = flattenReviewFileTree(props.files, collapsedPaths);
  const toggleDirectory = (path: string) => {
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  };
  const statusColors = STATUS_COLORS[themeAppearance];

  return (
    <LegendList
      key={props.listKey}
      renderScrollComponent={NativeScrollView}
      className="flex-1"
      data={rows}
      keyExtractor={(row) => (row.kind === "directory" ? `dir:${row.path}` : row.file.id)}
      extraData={[props.selectedFileId, statusColors, props.onSelectFile]}
      estimatedItemSize={ROW_HEIGHT}
      getFixedItemSize={() => ROW_HEIGHT}
      recycleItems
      refreshControl={props.refreshControl}
      {...(props.contentInset
        ? {
            contentInset: props.contentInset,
            contentInsetAdjustmentBehavior: "never" as const,
            automaticallyAdjustsScrollIndicatorInsets: false,
            scrollIndicatorInsets: props.contentInset,
          }
        : { contentInsetAdjustmentBehavior: "automatic" as const })}
      contentContainerStyle={{ paddingVertical: 8 }}
      renderItem={({ item }) => (
        <ReviewFileTreeRow
          row={item}
          selected={item.kind === "file" && item.file.id === props.selectedFileId}
          statusColors={statusColors}
          onToggleDirectory={toggleDirectory}
          onSelectFile={props.onSelectFile}
        />
      )}
      ListFooterComponent={<View className="h-2" />}
    />
  );
}
