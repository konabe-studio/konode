/**
 * Bookmarks this device keeps out of sync (#54).
 *
 * An extension that maintains a bookmark folder of its own (one reporter's mirrors a whole
 * website, thousands of entries) had Konode publishing and merging every one of them, and
 * the browser froze until it was done. The user picks folders or single bookmarks in a tree,
 * and those nodes leave the sync entirely: not exported, and invisible to the merge, which
 * therefore never creates, moves, renames or deletes anything inside them.
 *
 * Pure on purpose: everything here works on plain `{ id, title, url?, children? }` trees, so
 * the handler, the settings picker and the tests share one definition of "excluded".
 */

import type { BookmarkExclusion } from "@/lib/types";
import { rootKindOf, type RootLike } from "@/lib/utils/bookmark-roots";
import { canonicalUrlKey } from "@/lib/utils/url";

/** The shape every function here walks: a browser bookmark node and a SyncBookmark both fit. */
export interface ExclusionNode {
  id: string;
  title: string;
  url?: string;
  children?: ExclusionNode[];
}

/**
 * The first segment of a path: a root's kind, resolved the way the merge resolves it — the
 * engine's own folderType first, so a renumbered Edge profile (#66) keys its paths the same
 * as every other browser instead of falling through to a title. A root nobody recognises
 * keeps its title, which is at least stable on the device that has it.
 */
export function rootKey(root: RootLike): string {
  return rootKindOf(root) ?? `root:${(root.title ?? "").trim()}`;
}

function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/** Is `path` the folder `folder` or somewhere inside it? */
export function pathWithin(path: string[], folder: string[]): boolean {
  return folder.length <= path.length && folder.every((s, i) => s === path[i]);
}

/**
 * The stored list, made safe to use. Settings are read back from storage, and a malformed
 * entry must cost that entry only, not every exclusion or the sync itself.
 */
export function sanitizeExclusions(raw: unknown): BookmarkExclusion[] {
  if (!Array.isArray(raw)) return [];
  const out: BookmarkExclusion[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { path, url, id } = r as Partial<BookmarkExclusion>;
    if (!Array.isArray(path) || !path.length || !path.every((s) => typeof s === "string")) continue;
    const rule: BookmarkExclusion = { path: [...path] };
    if (typeof url === "string" && url) rule.url = url;
    if (typeof id === "string" && id) rule.id = id;
    out.push(rule);
  }
  return out;
}

export interface PartitionOptions<T extends ExclusionNode> {
  /**
   * Match rules by local id as well as by path. Only for this device's own tree: a peer's
   * ids are its own, and one of them can equal the id of something unrelated here.
   */
  byId: boolean;
  /**
   * The key of root number `index`. A peer's root has to be named after the LOCAL root it
   * merges into, or its copy of an excluded folder would not be recognised as one: Firefox's
   * Bookmarks Menu merges into Chrome's Other bookmarks. Defaults to the root's own key.
   */
  rootKeyOf?: (root: T, index: number) => string;
}

export interface Partition<T extends ExclusionNode> {
  /** The tree without the excluded nodes. An excluded ROOT stays as an empty shell, because
   *  the receiving merge also matches roots by position. */
  tree: T[];
  /** Every node that is excluded, with everything inside an excluded folder (and the root
   *  itself when a whole root is). */
  excludedIds: Set<string>;
  /** The path of each excluded folder as it stands in THIS tree. For a local tree that
   *  includes a folder matched by id under a newer name, which a peer may hold too. */
  folders: string[][];
  /** Each excluded bookmark as it stands in this tree. */
  bookmarks: Array<{ path: string[]; url: string }>;
}

interface Walker {
  /** Walk `nodes`, children of the folder at `path`, and return what syncs of them. */
  walk: (nodes: ExclusionNode[], path: string[]) => ExclusionNode[];
  folderOut: (n: ExclusionNode, path: string[]) => boolean;
  bookmarkOut: (n: ExclusionNode, parentPath: string[]) => boolean;
  collect: (n: ExclusionNode) => void;
  excludedIds: Set<string>;
  folders: string[][];
  bookmarks: Array<{ path: string[]; url: string }>;
}

function walker(rules: BookmarkExclusion[], byId: boolean): Walker {
  const excludedIds = new Set<string>();
  const folders: string[][] = [];
  const bookmarks: Array<{ path: string[]; url: string }> = [];
  const folderRules = rules.filter((r) => !r.url);
  const bookmarkRules = rules.filter((r) => r.url).map((r) => ({ ...r, key: canonicalUrlKey(r.url as string) }));
  const folderOut = (n: ExclusionNode, path: string[]): boolean =>
    folderRules.some((r) => (byId && r.id === n.id) || samePath(r.path, path));
  const bookmarkOut = (n: ExclusionNode, parentPath: string[]): boolean => {
    const key = canonicalUrlKey(n.url as string);
    return bookmarkRules.some((r) => (byId && r.id === n.id) || (r.key === key && samePath(r.path, parentPath)));
  };
  const collect = (n: ExclusionNode): void => {
    excludedIds.add(n.id);
    n.children?.forEach(collect);
  };
  const walk = (nodes: ExclusionNode[], path: string[]): ExclusionNode[] => {
    const kept: ExclusionNode[] = [];
    for (const n of nodes) {
      if (!n) continue;
      if (n.url) {
        if (bookmarkOut(n, path)) {
          excludedIds.add(n.id);
          bookmarks.push({ path, url: n.url });
        } else {
          kept.push(n);
        }
        continue;
      }
      const own = [...path, n.title];
      if (folderOut(n, own)) {
        collect(n);
        folders.push(own);
        continue;
      }
      kept.push(n.children ? { ...n, children: walk(n.children, own) } : n);
    }
    return kept;
  };
  return { walk, folderOut, bookmarkOut, collect, excludedIds, folders, bookmarks };
}

/**
 * Split a tree into what syncs and what stays here.
 *
 * Takes the tree as the browser and the sync payload hand it over: `[virtualRoot]` whose
 * children are the real roots. Read exactly as the merge reads it (`tree[0]?.children ??
 * tree`), because a path here is only right if it is the path the merge will walk.
 */
export function partitionExcluded<T extends ExclusionNode>(
  tree: T[],
  rules: BookmarkExclusion[],
  opts: PartitionOptions<T>,
): Partition<T> {
  if (!rules.length) return { tree, excludedIds: new Set(), folders: [], bookmarks: [] };
  const w = walker(rules, opts.byId);
  const virtual = tree[0]?.children ? tree[0] : null;
  const roots = (virtual ? virtual.children : tree) as T[];
  const keptRoots = roots.map((root, i) => {
    if (!root) return root;
    const key = opts.rootKeyOf ? opts.rootKeyOf(root, i) : rootKey(root);
    if (w.folderOut(root, [key])) {
      w.collect(root);
      w.folders.push([key]);
      return { ...root, children: [] };
    }
    return root.children ? { ...root, children: w.walk(root.children, [key]) } : root;
  });
  const out = (virtual ? [{ ...virtual, children: keptRoots }, ...tree.slice(1)] : keptRoots) as T[];
  return { tree: out, excludedIds: w.excludedIds, folders: w.folders, bookmarks: w.bookmarks };
}

/**
 * Does a rule of its own exclude `node`, sitting in the folder at `parentPath`? Says nothing
 * about the folders above it, which the caller already knows. On this device's tree only.
 */
export function excludedByOwnRule(node: ExclusionNode, parentPath: string[], rules: BookmarkExclusion[]): boolean {
  const w = walker(rules, true);
  return node.url ? w.bookmarkOut(node, parentPath) : w.folderOut(node, [...parentPath, node.title]);
}

/**
 * Could a rule of its own exclude `node`? The cheap half of excludedByOwnRule, which needs
 * the node's path, and a path costs a walk up the tree.
 */
export function mayHaveOwnRule(node: ExclusionNode, rules: BookmarkExclusion[]): boolean {
  const key = node.url ? canonicalUrlKey(node.url) : undefined;
  return rules.some((r) => r.id === node.id
    || (key ? !!r.url && canonicalUrlKey(r.url) === key : !r.url && r.path[r.path.length - 1] === node.title));
}

/**
 * The excluded nodes inside one subtree, given where it sits. For a removal: the removed
 * folder has left the tree, so only the event's own copy of it says what was inside.
 */
export function excludedInSubtree(node: ExclusionNode, parentPath: string[], rules: BookmarkExclusion[]): Set<string> {
  if (!rules.length) return new Set();
  const w = walker(rules, true);
  w.walk([node], parentPath);
  return w.excludedIds;
}

/**
 * The rules a peer's tree is pruned with: the stored ones, plus where each excluded node
 * actually is here. A folder kept excluded by its id after a rename sits under a path no
 * rule names, and the merge, which matches folders by title, would otherwise pour the peer's
 * copy of that name straight into it.
 */
export function peerRules(rules: BookmarkExclusion[], local: Partition<ExclusionNode>): BookmarkExclusion[] {
  return [
    ...rules.map(({ path, url }) => (url ? { path, url } : { path })),
    ...local.folders.map((path) => ({ path })),
    ...local.bookmarks.map(({ path, url }) => ({ path, url })),
  ];
}

/** Does any rule exclude the folder at `path` (or one above it)? For the path-keyed logs. */
export function folderPathExcluded(path: string[], folders: string[][]): boolean {
  return folders.some((f) => pathWithin(path, f));
}

// ─── The picker ─────────────────────────────────────────────────────────────

/** How the picker draws a node: ticked, partly ticked (something inside is), or neither. */
export type PickState = "on" | "mixed" | "off";

/** Every node's tick state under `rules`, from one walk of this device's tree. */
export function pickStates(tree: ExclusionNode[], rules: BookmarkExclusion[]): Map<string, PickState> {
  const { excludedIds } = partitionExcluded(tree, rules, { byId: true });
  const states = new Map<string, PickState>();
  const walk = (n: ExclusionNode): boolean => {
    if (excludedIds.has(n.id)) {
      const mark = (m: ExclusionNode): void => { states.set(m.id, "on"); m.children?.forEach(mark); };
      mark(n);
      return true;
    }
    let inside = false;
    for (const c of n.children ?? []) if (walk(c)) inside = true;
    states.set(n.id, inside ? "mixed" : "off");
    return inside;
  };
  tree.forEach(walk);
  return states;
}

interface Indexed {
  node: ExclusionNode;
  parent: string | null;
  /** A folder's own path; a bookmark's parent path. */
  path: string[];
  root: boolean;
}

function indexTree(tree: ExclusionNode[]): Map<string, Indexed> {
  const index = new Map<string, Indexed>();
  const walk = (nodes: ExclusionNode[], parent: string, path: string[]): void => {
    for (const n of nodes) {
      if (n.url) { index.set(n.id, { node: n, parent, path, root: false }); continue; }
      const own = [...path, n.title];
      index.set(n.id, { node: n, parent, path: own, root: false });
      walk(n.children ?? [], n.id, own);
    }
  };
  const virtual = tree[0]?.children ? tree[0] : null;
  const roots = virtual ? virtual.children ?? [] : tree;
  for (const root of roots) {
    const path = [rootKey(root)];
    index.set(root.id, { node: root, parent: null, path, root: true });
    walk(root.children ?? [], root.id, path);
  }
  return index;
}

/**
 * Tick or untick one node, and return the rules that describe the result.
 *
 * Ticking a folder excludes it as a whole, so whatever the extension adds to it later stays
 * out as well. Unticking one thing inside a ticked folder turns the folder into a list of
 * its other children. Ticking the last unticked child of a folder ticks the folder: that is
 * what the box shows, so it is what gets stored. Never a root, though: a root ticked as a
 * side effect would quietly exclude every bookmark saved to it from then on.
 *
 * A rule that matches nothing in this tree is kept as it was (the extension may simply not
 * have created its folder yet), so editing the picker never drops what it cannot show.
 */
export function toggleExclusion(
  tree: ExclusionNode[],
  rules: BookmarkExclusion[],
  nodeId: string,
  exclude: boolean,
): BookmarkExclusion[] {
  const index = indexTree(tree);
  const target = index.get(nodeId);
  if (!target) return rules;
  const out = new Set(partitionExcluded(tree, rules, { byId: true }).excludedIds);

  const subtree = (n: ExclusionNode, fn: (id: string) => void): void => {
    fn(n.id);
    n.children?.forEach((c) => subtree(c, fn));
  };
  if (exclude) {
    subtree(target.node, (id) => out.add(id));
    for (let p = target.parent; p; p = index.get(p)?.parent ?? null) {
      const up = index.get(p);
      if (!up || up.root) break;
      const kids = up.node.children ?? [];
      if (!kids.length || !kids.every((k) => out.has(k.id))) break;
      out.add(p);
    }
  } else {
    subtree(target.node, (id) => out.delete(id));
    for (let p = target.parent; p; p = index.get(p)?.parent ?? null) out.delete(p);
  }

  const next: BookmarkExclusion[] = [];
  const emit = (id: string): void => {
    const e = index.get(id);
    if (!e) return;
    if (out.has(id)) {
      next.push(e.node.url ? { path: e.path, url: e.node.url, id } : { path: e.path, id });
      return;
    }
    e.node.children?.forEach((c) => emit(c.id));
  };
  for (const [id, e] of index) if (e.root) emit(id);

  const matchesHere = (r: BookmarkExclusion): boolean => {
    for (const [id, e] of index) {
      if (r.id === id) return true;
      if (r.url ? (e.node.url && canonicalUrlKey(e.node.url) === canonicalUrlKey(r.url) && samePath(e.path, r.path))
        : (!e.node.url && samePath(e.path, r.path))) return true;
    }
    return false;
  };
  return [...next, ...rules.filter((r) => !matchesHere(r))];
}
