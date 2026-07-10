import { describe, it, expect } from "vitest";
import { normalizeRepoSlug } from "@/lib/backends/github-backend";

describe("normalizeRepoSlug", () => {
  it("passes through a clean owner/repo", () => {
    expect(normalizeRepoSlug("benstone326/konode-sync")).toBe("benstone326/konode-sync");
  });

  it("strips a full https URL", () => {
    expect(normalizeRepoSlug("https://github.com/benstone326/konode-sync")).toBe(
      "benstone326/konode-sync"
    );
  });

  it("strips a .git suffix and a trailing slash", () => {
    expect(normalizeRepoSlug("https://github.com/benstone326/konode-sync.git")).toBe(
      "benstone326/konode-sync"
    );
    expect(normalizeRepoSlug("benstone326/konode-sync/")).toBe("benstone326/konode-sync");
  });

  it("strips the git@ SSH form and surrounding whitespace", () => {
    expect(normalizeRepoSlug("  git@github.com:benstone326/konode-sync.git  ")).toBe(
      "benstone326/konode-sync"
    );
  });

  it("returns an empty string for empty/undefined input", () => {
    expect(normalizeRepoSlug(undefined)).toBe("");
    expect(normalizeRepoSlug("")).toBe("");
  });
});
