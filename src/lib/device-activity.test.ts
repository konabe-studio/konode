import { describe, it, expect } from "vitest";
import { DORMANT_DEVICE_DAYS, isDormant, relativeTime } from "@/lib/device-activity";

const NOW = Date.parse("2026-11-04T09:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;

describe("relativeTime", () => {
  it("says how long ago in words, the way the issue asks (#10)", () => {
    expect(relativeTime(ago(39 * DAY), NOW, "en")).toBe("39 days ago");
    expect(relativeTime(ago(3 * HOUR + 20 * MIN), NOW, "en")).toBe("3 hours ago");
    expect(relativeTime(ago(5 * MIN), NOW, "en")).toBe("5 minutes ago");
    expect(relativeTime(ago(12 * SEC), NOW, "en")).toBe("12 seconds ago");
  });

  it("keeps counting days past a month, since the inactive mark is measured in days", () => {
    expect(relativeTime(ago(59 * DAY), NOW, "en")).toBe("59 days ago");
    expect(relativeTime(ago(60 * DAY), NOW, "en")).toBe("2 months ago");
    expect(relativeTime(ago(400 * DAY), NOW, "en")).toBe("1 year ago");
  });

  it("never says yesterday, which is a calendar claim the hours cannot back", () => {
    // 40 hours before 9 in the morning is the afternoon of the day BEFORE yesterday.
    expect(relativeTime(ago(40 * HOUR), NOW, "en")).toBe("1 day ago");
  });

  it("reads a future time, which only a skewed clock produces, as now", () => {
    expect(relativeTime(ago(-5 * MIN), NOW, "en")).toBe("now");
  });

  it("speaks the language it is given, not the test machine's", () => {
    expect(relativeTime(ago(39 * DAY), NOW, "hu")).toBe("39 nappal ezelőtt");
    expect(relativeTime(ago(39 * DAY), NOW, "de")).toBe("vor 39 Tagen");
  });

  it("does not throw on a timestamp it cannot read", () => {
    expect(() => relativeTime("not a date", NOW, "en")).not.toThrow();
  });
});

describe("isDormant", () => {
  it(`marks a peer silent for more than ${DORMANT_DEVICE_DAYS} days, and not one day sooner`, () => {
    expect(isDormant(ago(DORMANT_DEVICE_DAYS * DAY), false, NOW)).toBe(false);
    expect(isDormant(ago(DORMANT_DEVICE_DAYS * DAY + MIN), false, NOW)).toBe(true);
    expect(isDormant(ago(2 * DAY), false, NOW)).toBe(false);
  });

  it("never marks this device, whose own last upload can be old while it runs", () => {
    // A device uploads only when something changed, so a bookmarks-only browser in daily
    // use can sit here for weeks. Calling the browser you are holding inactive is absurd.
    expect(isDormant(ago(90 * DAY), true, NOW)).toBe(false);
  });

  it("calls an unknown time unknown, not old", () => {
    expect(isDormant(null, false, NOW)).toBe(false);
    expect(isDormant("garbage", false, NOW)).toBe(false);
  });
});
