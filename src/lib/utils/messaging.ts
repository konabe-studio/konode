import type { ExtensionMessage, ExtensionResponse } from "@/lib/types";
import { browser } from "@/lib/utils/ext";

export async function sendMessage(message: ExtensionMessage): Promise<ExtensionResponse> {
  return browser.runtime.sendMessage(message);
}
