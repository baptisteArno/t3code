import type { T3ProjectFile } from "@t3tools/contracts";

import { isTestChangedFile } from "./changedFileKind.ts";
import { parseT3ProjectFile } from "./t3ProjectFile.ts";

type DiffFileConfig = NonNullable<T3ProjectFile["diff"]>;

interface HiddenPattern {
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly regex: RegExp;
}

interface OrderRule {
  readonly parent: ReadonlyArray<string>;
  readonly children: ReadonlyArray<(name: string) => boolean>;
}

export interface DiffFileRules {
  /** Identity of the configuration, for caches keyed by string. */
  readonly key: string;
  readonly hidden: ReadonlyArray<HiddenPattern>;
  readonly order: ReadonlyArray<OrderRule>;
}

export const BUILT_IN_DIFF_FILE_RULES: DiffFileRules = { key: "", hidden: [], order: [] };

const rulesByContents = new Map<string, DiffFileRules>();
const MAX_CACHED_CONTENTS = 16;

/** Rules from a t3.json's contents, compiled once per contents. */
export function diffFileRulesFromT3ProjectFile(contents: string | null): DiffFileRules {
  if (contents === null) return BUILT_IN_DIFF_FILE_RULES;
  let rules = rulesByContents.get(contents);
  if (rules === undefined) {
    rules = compileDiffFileRules(parseT3ProjectFile(contents)?.diff);
    if (rulesByContents.size >= MAX_CACHED_CONTENTS) rulesByContents.clear();
    rulesByContents.set(contents, rules);
  }
  return rules;
}

export function compileDiffFileRules(config: DiffFileConfig | undefined): DiffFileRules {
  const hidden = (config?.hiddenFiles ?? []).flatMap((pattern) => {
    const compiled = compileHiddenPattern(pattern);
    return compiled === null ? [] : [compiled];
  });
  const order = Object.entries(config?.sort ?? {}).map(([parent, children]) => ({
    parent: (parent === "." ? "" : parent.replace(/^\.\//, ""))
      .split("/")
      .filter((segment) => segment !== ""),
    children: children.flatMap((child) => {
      const matcher = compileNameMatcher(child);
      return matcher === null ? [] : [matcher];
    }),
  }));
  if (hidden.length === 0 && order.length === 0) return BUILT_IN_DIFF_FILE_RULES;
  return { key: JSON.stringify(config), hidden, order };
}

export function hideDiffFilesLabel(rules: DiffFileRules): string {
  return rules.hidden.length > 0 ? "Hide test files and t3.json hiddenFiles" : "Hide test files";
}

/** "test files" until t3.json adds patterns, since hidden files are then not all tests. */
export function hiddenDiffFilesNoun(rules: DiffFileRules, count: number): string {
  const noun = count === 1 ? "file" : "files";
  return rules.hidden.length > 0 ? noun : `test ${noun}`;
}

/** Built-in test detection, then the configured patterns; the last matching pattern wins. */
export function isHiddenDiffFile(rules: DiffFileRules, path: string): boolean {
  let hidden = isTestChangedFile(path);
  if (rules.hidden.length === 0) return hidden;
  const segments = path.split("/");
  const directories = segments
    .slice(0, -1)
    .map((_, index) => segments.slice(0, index + 1).join("/"));
  for (const pattern of rules.hidden) {
    if (hidden !== pattern.negated) continue;
    const matches =
      directories.some((directory) => pattern.regex.test(directory)) ||
      (!pattern.directoryOnly && pattern.regex.test(path));
    if (matches) hidden = !pattern.negated;
  }
  return hidden;
}

/**
 * Reorders items by the configured folder rules. Folders stay contiguous; siblings no rule ranks
 * keep the order they arrive in, so callers keep their own default ordering.
 */
export function applyDiffFileOrder<T>(
  rules: DiffFileRules,
  items: ReadonlyArray<T>,
  pathOf: (item: T) => string,
): ReadonlyArray<T> {
  if (rules.order.length === 0 || items.length < 2) return items;
  const firstSeen = new Map<string, number>();
  const segmentsByItem = items.map((item, index) => {
    const segments = pathOf(item).split("/");
    let prefix = "";
    for (const segment of segments) {
      prefix += `${segment}/`;
      if (!firstSeen.has(prefix)) firstSeen.set(prefix, index);
    }
    return segments;
  });
  const rankByPrefix = new Map<string, number>();
  const keyed = segmentsByItem.map((segments, index) => {
    const key: number[] = [];
    let prefix = "";
    segments.forEach((segment, depth) => {
      prefix += `${segment}/`;
      let rank = rankByPrefix.get(prefix);
      if (rank === undefined) {
        rank = childRank(rules.order, segments.slice(0, depth), segment);
        rankByPrefix.set(prefix, rank);
      }
      key.push(rank, firstSeen.get(prefix)!);
    });
    return { item: items[index]!, key, index };
  });
  return keyed
    .sort((left, right) => {
      const length = Math.min(left.key.length, right.key.length);
      for (let position = 0; position < length; position++) {
        const difference = left.key[position]! - right.key[position]!;
        if (difference !== 0) return difference;
      }
      return left.key.length - right.key.length || left.index - right.index;
    })
    .map(({ item }) => item);
}

function childRank(
  rules: ReadonlyArray<OrderRule>,
  parent: ReadonlyArray<string>,
  name: string,
): number {
  const rule = rules.find((candidate) => matchesParent(candidate.parent, parent, 0, 0));
  if (rule === undefined) return 0;
  const rank = rule.children.findIndex((matches) => matches(name));
  return rank < 0 ? rule.children.length : rank;
}

function matchesParent(
  pattern: ReadonlyArray<string>,
  parent: ReadonlyArray<string>,
  patternIndex: number,
  parentIndex: number,
): boolean {
  if (patternIndex === pattern.length) return parentIndex === parent.length;
  const segment = pattern[patternIndex]!;
  if (segment === "**") {
    return (
      matchesParent(pattern, parent, patternIndex + 1, parentIndex) ||
      (parentIndex < parent.length && matchesParent(pattern, parent, patternIndex, parentIndex + 1))
    );
  }
  if (parentIndex === parent.length) return false;
  return (
    (compileNameMatcher(segment)?.(parent[parentIndex]!) ?? false) &&
    matchesParent(pattern, parent, patternIndex + 1, parentIndex + 1)
  );
}

const nameMatchers = new Map<string, ((name: string) => boolean) | null>();

function compileNameMatcher(pattern: string): ((name: string) => boolean) | null {
  if (nameMatchers.has(pattern)) return nameMatchers.get(pattern)!;
  let matcher: ((name: string) => boolean) | null = null;
  if (pattern !== "" && !pattern.includes("/")) {
    if (!pattern.includes("*")) matcher = (name) => name === pattern;
    else {
      const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
      matcher = (name) => regex.test(name);
    }
  }
  nameMatchers.set(pattern, matcher);
  return matcher;
}

function compileHiddenPattern(raw: string): HiddenPattern | null {
  let pattern = raw.trim();
  if (pattern === "" || pattern.startsWith("#")) return null;
  const negated = pattern.startsWith("!");
  if (negated) pattern = pattern.slice(1);
  const directoryOnly = pattern.endsWith("/");
  pattern = pattern.replace(/\/+$/, "");
  // As in .gitignore, a slash anywhere but the end anchors the pattern to the root.
  const anchored = pattern.includes("/");
  pattern = pattern.replace(/^\/+/, "");
  if (pattern === "") return null;
  try {
    return {
      negated,
      directoryOnly,
      regex: new RegExp(`^${anchored ? "" : "(?:.*/)?"}${globSource(pattern)}$`),
    };
  } catch {
    return null;
  }
}

function globSource(glob: string): string {
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === "*") {
      const segmentStart = index === 0 || glob[index - 1] === "/";
      if (glob[index + 1] === "*" && segmentStart && glob[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else if (glob[index + 1] === "*" && segmentStart && index + 2 === glob.length) {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
        while (glob[index + 1] === "*") index++;
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[" && glob.indexOf("]", index + 2) > 0) {
      const end = glob.indexOf("]", index + 2);
      source += `[${glob
        .slice(index + 1, end)
        .replace(/^!/, "^")
        .replaceAll("\\", "\\\\")}]`;
      index = end;
    } else if (char === "\\" && index + 1 < glob.length) {
      index++;
      source += escapeRegExp(glob[index]!);
    } else {
      source += escapeRegExp(char);
    }
  }
  return source;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
