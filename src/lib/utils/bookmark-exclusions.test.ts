import { describe, it, expect } from "vitest";
import {
  partitionExcluded, peerRules, pickStates, sanitizeExclusions, toggleExclusion, type ExclusionNode,
} from "@/lib/utils/bookmark-exclusions";

// A Chrome-shaped tree: the virtual root "0" over the bar ("1") and Other bookmarks ("2").
//   bar/Work/{a, b}, bar/Ext/{Sub/{c}, d}, bar/e, other/f
function tree(): ExclusionNode[] {
  return [{
    id: "0", title: "", children: [
      { id: "1", title: "Bookmarks bar", children: [
        { id: "10", title: "Work", children: [
          { id: "11", title: "a", url: "https://a.com/" },
          { id: "12", title: "b", url: "https://b.com/" },
        ] },
        { id: "20", title: "Ext", children: [
          { id: "21", title: "Sub", children: [{ id: "22", title: "c", url: "https://c.com/" }] },
          { id: "23", title: "d", url: "https://d.com/" },
        ] },
        { id: "30", title: "e", url: "https://e.com/" },
      ] },
      { id: "2", title: "Other bookmarks", children: [{ id: "40", title: "f", url: "https://f.com/" }] },
    ],
  }];
}

function urls(nodes: ExclusionNode[]): string[] {
  const out: string[] = [];
  const walk = (n: ExclusionNode) => { if (n.url) out.push(n.url); n.children?.forEach(walk); };
  nodes.forEach(walk);
  return out.sort();
}

describe("partitionExcluded (#54)", () => {
  it("takes an excluded folder out whole, with everything inside it", () => {
    const p = partitionExcluded(tree(), [{ path: ["bar", "Ext"] }], { byId: true });
    expect(urls(p.tree)).toEqual(["https://a.com/", "https://b.com/", "https://e.com/", "https://f.com/"]);
    expect([...p.excludedIds].sort()).toEqual(["20", "21", "22", "23"]);
    expect(p.folders).toEqual([["bar", "Ext"]]);
  });

  it("takes out a single bookmark by its folder and canonical URL", () => {
    // A bare origin is the same bookmark with or without its trailing slash.
    const p = partitionExcluded(tree(), [{ path: ["bar", "Work"], url: "https://a.com" }], { byId: true });
    expect(urls(p.tree)).not.toContain("https://a.com/");
    expect(urls(p.tree)).toContain("https://b.com/");
    expect(p.bookmarks).toEqual([{ path: ["bar", "Work"], url: "https://a.com/" }]);
  });

  it("leaves the same URL in another folder alone", () => {
    const p = partitionExcluded(tree(), [{ path: ["other"], url: "https://e.com/" }], { byId: true });
    expect(urls(p.tree)).toContain("https://e.com/");
  });

  it("follows a renamed folder by its id on this device, never on a peer's tree", () => {
    const renamed = tree();
    renamed[0].children![0].children![1].title = "Ext (renamed)";
    const rules = [{ path: ["bar", "Ext"], id: "20" }];
    expect(partitionExcluded(renamed, rules, { byId: true }).excludedIds.has("20")).toBe(true);
    // A peer's "20" is whatever that browser numbered 20.
    expect(partitionExcluded(renamed, rules, { byId: false }).excludedIds.has("20")).toBe(false);
  });

  it("keeps an excluded root as an empty shell, so the peer's roots still line up by position", () => {
    const p = partitionExcluded(tree(), [{ path: ["bar"] }], { byId: true });
    const roots = p.tree[0].children!;
    expect(roots.map((r) => r.id)).toEqual(["1", "2"]);
    expect(roots[0].children).toEqual([]);
    expect(p.excludedIds.has("1")).toBe(true);
  });

  it("names a peer's roots after the local roots they merge into", () => {
    // A Firefox Bookmarks Menu merges into Chrome's Other bookmarks.
    const peer: ExclusionNode[] = [{ id: "root________", title: "", children: [
      { id: "menu________", title: "Bookmarks Menu", children: [
        { id: "x", title: "Ext", children: [{ id: "y", title: "z", url: "https://z.com/" }] },
      ] },
    ] }];
    const p = partitionExcluded(peer, [{ path: ["other", "Ext"] }], { byId: false, rootKeyOf: () => "other" });
    expect(urls(p.tree)).toEqual([]);
  });

  it("changes nothing without rules", () => {
    const t = tree();
    expect(partitionExcluded(t, [], { byId: true }).tree).toBe(t);
  });
});

describe("peerRules", () => {
  it("adds where an excluded folder actually is, for a peer holding it under that name", () => {
    const renamed = tree();
    renamed[0].children![0].children![1].title = "Ext (renamed)";
    const local = partitionExcluded(renamed, [{ path: ["bar", "Ext"], id: "20" }], { byId: true });
    expect(peerRules([{ path: ["bar", "Ext"], id: "20" }], local)).toEqual([
      { path: ["bar", "Ext"] },
      { path: ["bar", "Ext (renamed)"] },
    ]);
  });
});

describe("the picker (#54)", () => {
  it("ticking a folder stores the folder, so what the extension adds to it later stays out too", () => {
    expect(toggleExclusion(tree(), [], "20", true)).toEqual([{ path: ["bar", "Ext"], id: "20" }]);
  });

  it("unticking one thing inside a ticked folder keeps the rest of the folder ticked", () => {
    const rules = toggleExclusion(tree(), [{ path: ["bar", "Ext"], id: "20" }], "23", false);
    expect(rules).toEqual([{ path: ["bar", "Ext", "Sub"], id: "21" }]);
    const states = pickStates(tree(), rules);
    expect(states.get("20")).toBe("mixed");
    expect(states.get("22")).toBe("on");
    expect(states.get("23")).toBe("off");
  });

  it("ticking the last unticked child ticks its folder", () => {
    let rules = toggleExclusion(tree(), [], "11", true);
    expect(pickStates(tree(), rules).get("10")).toBe("mixed");
    rules = toggleExclusion(tree(), rules, "12", true);
    expect(rules).toEqual([{ path: ["bar", "Work"], id: "10" }]);
  });

  it("never ticks a root as a side effect", () => {
    // Other bookmarks holds just f. Ticking f must not exclude everything ever saved there.
    expect(toggleExclusion(tree(), [], "40", true)).toEqual([{ path: ["other"], url: "https://f.com/", id: "40" }]);
  });

  it("a whole root can still be ticked on purpose", () => {
    expect(toggleExclusion(tree(), [], "2", true)).toEqual([{ path: ["other"], id: "2" }]);
  });

  it("keeps a rule it cannot show", () => {
    // The extension may not have made its folder yet on this device.
    const absent = { path: ["bar", "Not here"] };
    expect(toggleExclusion(tree(), [absent], "30", true)).toEqual([
      { path: ["bar"], url: "https://e.com/", id: "30" },
      absent,
    ]);
  });

  it("unticking the folder clears it", () => {
    expect(toggleExclusion(tree(), [{ path: ["bar", "Ext"], id: "20" }], "20", false)).toEqual([]);
  });
});

describe("sanitizeExclusions", () => {
  it("keeps the well-formed entries and drops the rest", () => {
    expect(sanitizeExclusions([
      { path: ["bar", "Ext"], id: "20" },
      { path: ["bar"], url: "https://a.com/" },
      { path: [] },
      { path: "bar" },
      { path: ["bar", 3] },
      null,
      "x",
    ])).toEqual([{ path: ["bar", "Ext"], id: "20" }, { path: ["bar"], url: "https://a.com/" }]);
    expect(sanitizeExclusions(undefined)).toEqual([]);
  });
});
