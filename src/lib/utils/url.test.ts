import { describe, it, expect } from "vitest";
import { isSafeContentUrl, isSecureBackendUrl } from "@/lib/utils/url";

describe("isSafeContentUrl", () => {
  it("allows http(s) web URLs", () => {
    expect(isSafeContentUrl("https://example.com/page")).toBe(true);
    expect(isSafeContentUrl("http://example.com")).toBe(true);
  });
  it("rejects injection/exfiltration schemes", () => {
    expect(isSafeContentUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeContentUrl("data:text/html,<script>1</script>")).toBe(false);
    expect(isSafeContentUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeContentUrl("chrome://settings")).toBe(false);
  });
  it("rejects empty / malformed input", () => {
    expect(isSafeContentUrl("")).toBe(false);
    expect(isSafeContentUrl(undefined)).toBe(false);
    expect(isSafeContentUrl("not a url")).toBe(false);
  });
});

describe("isSecureBackendUrl", () => {
  it("allows https", () => {
    expect(isSecureBackendUrl("https://cloud.example.com/remote.php/dav")).toBe(true);
  });
  it("allows http only for loopback hosts", () => {
    expect(isSecureBackendUrl("http://localhost:8080/dav")).toBe(true);
    expect(isSecureBackendUrl("http://127.0.0.1/dav")).toBe(true);
    expect(isSecureBackendUrl("http://[::1]:5000/dav")).toBe(true);
  });
  it("rejects http to any non-loopback host", () => {
    expect(isSecureBackendUrl("http://cloud.example.com/dav")).toBe(false);
    expect(isSecureBackendUrl("http://192.168.1.10/dav")).toBe(false);
  });
  it("rejects empty / malformed input", () => {
    expect(isSecureBackendUrl("")).toBe(false);
    expect(isSecureBackendUrl(undefined)).toBe(false);
  });
});
