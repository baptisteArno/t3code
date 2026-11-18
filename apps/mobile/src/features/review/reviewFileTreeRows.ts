import type { ReviewRenderableFile } from "./reviewModel";

export type ReviewFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface ReviewTreeFile {
  readonly id: string;
  readonly path: string;
  readonly status: ReviewFileStatus;
  readonly additions: number;
  readonly deletions: number;
}

export type ReviewTreeRow =
  | {
      readonly kind: "directory";
      /** The directory's full path, also its collapse key. */
      readonly path: string;
      /** Single-child directory chains read as one row, such as `apps/mobile/src`. */
      readonly name: string;
      readonly depth: number;
      readonly collapsed: boolean;
    }
  | {
      readonly kind: "file";
      readonly file: ReviewTreeFile;
      readonly name: string;
      readonly depth: number;
    };

export function reviewFileStatus(changeType: ReviewRenderableFile["changeType"]): ReviewFileStatus {
  switch (changeType) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    default:
      return "modified";
  }
}

interface DirectoryNode {
  readonly path: string;
  // Insertion order is diff order, so the tree lists entries where the diff first reaches them.
  readonly children: Map<string, DirectoryNode | ReviewTreeFile>;
}

function isDirectory(node: DirectoryNode | ReviewTreeFile): node is DirectoryNode {
  return "children" in node;
}

function buildDirectoryTree(files: ReadonlyArray<ReviewTreeFile>): DirectoryNode {
  const root: DirectoryNode = { path: "", children: new Map() };
  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    let directory = root;
    for (const segment of segments.slice(0, -1)) {
      const key = `${segment}/`;
      let child = directory.children.get(key);
      if (child === undefined || !isDirectory(child)) {
        child = { path: `${directory.path}${segment}/`, children: new Map() };
        directory.children.set(key, child);
      }
      directory = child;
    }
    directory.children.set(file.id, file);
  }
  return root;
}

/** Rows in display order, like the web diff tree: compacted directories, hidden while collapsed. */
export function flattenReviewFileTree(
  files: ReadonlyArray<ReviewTreeFile>,
  collapsedPaths: ReadonlySet<string>,
): ReadonlyArray<ReviewTreeRow> {
  const rows: ReviewTreeRow[] = [];
  const visit = (directory: DirectoryNode, depth: number) => {
    for (const child of directory.children.values()) {
      if (!isDirectory(child)) {
        rows.push({ kind: "file", file: child, name: child.path.split("/").at(-1)!, depth });
        continue;
      }
      let compacted = child;
      let name = compacted.path.slice(directory.path.length, -1);
      while (compacted.children.size === 1) {
        const only = compacted.children.values().next().value!;
        if (!isDirectory(only)) break;
        name += `/${only.path.slice(compacted.path.length, -1)}`;
        compacted = only;
      }
      const collapsed = collapsedPaths.has(compacted.path);
      rows.push({ kind: "directory", path: compacted.path, name, depth, collapsed });
      if (!collapsed) visit(compacted, depth + 1);
    }
  };
  visit(buildDirectoryTree(files), 0);
  return rows;
}
