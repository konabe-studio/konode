import type { ExtensionMessage, ExtensionResponse } from "@/lib/types";

export async function sendMessage(message: ExtensionMessage): Promise<ExtensionResponse> {
  return chrome.runtime.sendMessage(message);
}
