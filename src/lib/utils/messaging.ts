import type { ExtensionMessage, ExtensionResponse } from "@/lib/types";
import { browser } from "@/lib/utils/ext";

export async function sendMessage(message: ExtensionMessage): Promise<ExtensionResponse> {
  return browser.runtime.sendMessage(message);
}

/** A response, or the reason there isn't one. */
export type Sent =
  | { ok: true; res: Exclude<ExtensionResponse, { type: "ERROR" }> }
  | { ok: false; error: string };

/**
 * `sendMessage` with the failure made explicit — use this from the UI.
 *
 * Two different failures used to vanish at every call site. An `{ type: "ERROR" }`
 * response that the caller never checked, and a REJECTION of the round-trip itself (the
 * worker was cold, or the handler threw before answering), which became an unhandled
 * promise rejection. Both looked identical to the user: nothing happened.
 *
 * Worse, some callers then treated "no data" and "couldn't load" as the same thing. The
 * Activity tab announced "No restore points yet" when the list had merely failed to
 * load — the worst possible lie to tell on a recovery screen.
 *
 * So: never `sendMessage` from the UI without handling the `ok: false` branch.
 */
export async function request(message: ExtensionMessage): Promise<Sent> {
  let res: ExtensionResponse | undefined;
  try {
    res = await sendMessage(message);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error && e.message
        ? e.message
        : "Couldn't reach Konode's background worker.",
    };
  }
  if (!res) return { ok: false, error: "No response from Konode's background worker." };
  if (res.type === "ERROR") return { ok: false, error: res.payload };
  return { ok: true, res };
}
