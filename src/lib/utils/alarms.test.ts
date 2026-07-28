import { describe, it, expect } from "vitest";
import { ensureSyncAlarm, SYNC_ALARM } from "@/lib/utils/alarms";

// MV3 recreates the service worker for every event it listens for — a popup opening, a
// message, a bookmark change — and init() runs once per worker lifetime. Setup used to
// clear() + create() the periodic alarm unconditionally, so every wake reset its next
// fire to now + period. Ordinary browsing could push the periodic pull back
// indefinitely, and that pull is how a device picks up its PEERS' edits.

const alarm = async () => (await chrome.alarms.get(SYNC_ALARM)) as
  | { name: string; periodInMinutes?: number }
  | undefined;

describe("ensureSyncAlarm", () => {
  it("creates the alarm when none exists", async () => {
    expect(await ensureSyncAlarm(60)).toBe(true);
    expect((await alarm())?.periodInMinutes).toBe(1);
  });

  it("leaves a running alarm alone on repeated worker wakes", async () => {
    await ensureSyncAlarm(60);

    // Every one of these stands for another worker wake calling init().
    for (let i = 0; i < 5; i++) expect(await ensureSyncAlarm(60)).toBe(false);

    expect(await alarm()).toBeDefined(); // still scheduled, never restarted
  });

  it("recreates it when forced — a real interval change", async () => {
    await ensureSyncAlarm(60);
    expect((await alarm())?.periodInMinutes).toBe(1);

    expect(await ensureSyncAlarm(300, true)).toBe(true);
    expect((await alarm())?.periodInMinutes).toBe(5);
  });

  it("does NOT pick up a new interval without force — that's SAVE_SETTINGS' job", async () => {
    // Deliberate: comparing the stored periodInMinutes would put us back to recreating
    // on every wake if the browser ever clamps or rounds what it kept. The interval only
    // changes through SAVE_SETTINGS, which forces.
    await ensureSyncAlarm(60);
    expect(await ensureSyncAlarm(300)).toBe(false);
    expect((await alarm())?.periodInMinutes).toBe(1);
  });

  it("re-creates it after something cleared it (extension update, browser restart)", async () => {
    await ensureSyncAlarm(60);
    await chrome.alarms.clear(SYNC_ALARM);

    expect(await ensureSyncAlarm(60)).toBe(true);
    expect(await alarm()).toBeDefined();
  });

  it("floors the period at the platform minimum of 30s", async () => {
    await ensureSyncAlarm(5); // 5s would be 0.083 min
    expect((await alarm())?.periodInMinutes).toBe(0.5);
  });
});
