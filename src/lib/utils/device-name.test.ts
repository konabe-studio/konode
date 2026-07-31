import { describe, it, expect, afterEach, vi } from "vitest";
import { detectDeviceName } from "@/lib/utils/storage";

// The device label is user-facing: it names the device in Settings, and it names the peer
// whose session or extension list you are looking at in the popup. Every case below is a
// real user agent string.

const named = (ua: string): string => {
  vi.stubGlobal("navigator", { userAgent: ua });
  return detectDeviceName();
};

afterEach(() => { vi.unstubAllGlobals(); });

describe("detectDeviceName — the OS half", () => {
  it("does not claim Windows 11 on a Windows 10 machine", () => {
    // Microsoft never bumped the UA token: Windows 10 and Windows 11 BOTH send
    // "Windows NT 10.0". Every Windows 10 user was told they were on 11.
    const win10 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    expect(named(win10)).toBe("Windows 10/11 · Chrome");
  });

  it("recognises Android instead of calling it Linux", () => {
    // A Chromium Android UA carries the "Linux" token, which the desktop branch matched
    // first — so those phones never once identified as Android.
    const androidChromium = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
    expect(named(androidChromium)).toBe("Android · Chrome");

    // Firefox for Android omits "Linux", so this one was already right — keep it covered
    // so the reordering can't break the case that used to work. This is Konode's
    // supported Android path.
    const androidFirefox = "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0";
    expect(named(androidFirefox)).toBe("Android · Firefox");
  });

  it("recognises iOS instead of calling it Mac", () => {
    // An iPhone UA contains "Mac OS X", matched by the Mac branch above it.
    // No Safari branch in the browser half, so the label is the bare OS — which is the
    // current behaviour, not an oversight this test is papering over.
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
    expect(named(iphone)).toBe("iOS");
  });

  it("still names a real Mac, a real Linux desktop and older Windows", () => {
    expect(named("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"))
      .toBe("Mac · Chrome");
    expect(named("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"))
      .toBe("Linux · Chrome");
    expect(named("Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36"))
      .toBe("Windows 7 · Chrome");
  });

  it("falls back to a neutral label rather than guessing", () => {
    expect(named("Some/1.0 (unknown platform)")).toBe("Device");
  });
});
