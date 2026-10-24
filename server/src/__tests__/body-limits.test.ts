import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_JSON_BODY_LIMIT,
  MAX_COMMENT_BODY_CHARS,
  PORTABLE_JSON_BODY_LIMIT,
  PORTABLE_JSON_BODY_LIMIT_BYTES,
  PORTABLE_ZIP_UPLOAD_LIMIT_BYTES,
  REQUEST_BODY_TIMEOUT_MS,
} from "../http/body-limits.js";

describe("HTTP body limits", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps the global JSON parser at the established ceiling", () => {
    expect(DEFAULT_JSON_BODY_LIMIT).toBe("10mb");
  });

  it("allows PAP-scale portable import JSON payloads", () => {
    expect(PORTABLE_JSON_BODY_LIMIT).toBe("64mb");
    expect(PORTABLE_JSON_BODY_LIMIT_BYTES).toBe(64 * 1024 * 1024);
    expect(PORTABLE_JSON_BODY_LIMIT_BYTES).toBeGreaterThan(10 * 1024 * 1024);
  });

  it("accepts large real-world compressed company packages by default", () => {
    expect(PORTABLE_ZIP_UPLOAD_LIMIT_BYTES).toBe(1024 * 1024 * 1024);
  });

  it("lets operators override the zip upload cap via PAPERCLIP_IMPORT_ZIP_MAX_BYTES", async () => {
    vi.stubEnv("PAPERCLIP_IMPORT_ZIP_MAX_BYTES", String(2 * 1024 * 1024 * 1024));
    vi.resetModules();
    const reloaded = await import("../http/body-limits.js");
    expect(reloaded.PORTABLE_ZIP_UPLOAD_LIMIT_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });

  it("falls back to the default when the env override is not a usable number", async () => {
    for (const raw of ["unlimited", "0", "-5", "0.5"]) {
      vi.stubEnv("PAPERCLIP_IMPORT_ZIP_MAX_BYTES", raw);
      vi.resetModules();
      const reloaded = await import("../http/body-limits.js");
      expect(reloaded.PORTABLE_ZIP_UPLOAD_LIMIT_BYTES, `override ${JSON.stringify(raw)}`).toBe(
        1024 * 1024 * 1024,
      );
    }
  });

  it("clamps an oversized override so derived guard math cannot overflow", async () => {
    vi.stubEnv("PAPERCLIP_IMPORT_ZIP_MAX_BYTES", String(Number.MAX_VALUE));
    vi.resetModules();
    const reloaded = await import("../http/body-limits.js");
    expect(reloaded.PORTABLE_ZIP_UPLOAD_LIMIT_BYTES).toBe(64 * 1024 * 1024 * 1024);
    expect(Number.isSafeInteger(reloaded.PORTABLE_ZIP_UPLOAD_LIMIT_BYTES * 4)).toBe(true);
  });

  it("lets operators set the JSON body ceiling via PAPERCLIP_JSON_BODY_LIMIT", async () => {
    vi.stubEnv("PAPERCLIP_JSON_BODY_LIMIT", "5mb");
    vi.resetModules();
    expect((await import("../http/body-limits.js")).DEFAULT_JSON_BODY_LIMIT).toBe(5 * 1024 * 1024);
    for (const raw of ["", "lots", "0", "-1mb"]) {
      vi.stubEnv("PAPERCLIP_JSON_BODY_LIMIT", raw);
      vi.resetModules();
      expect((await import("../http/body-limits.js")).DEFAULT_JSON_BODY_LIMIT, `override ${JSON.stringify(raw)}`).toBe("10mb");
    }
  });

  it("caps comment bodies at 256K characters unless overridden", async () => {
    expect(MAX_COMMENT_BODY_CHARS).toBe(262_144);
    vi.stubEnv("PAPERCLIP_MAX_COMMENT_BODY_CHARS", "1000000");
    vi.resetModules();
    expect((await import("../http/body-limits.js")).MAX_COMMENT_BODY_CHARS).toBe(1_000_000);
  });

  it("guards request bodies for 30s by default and allows disabling the guard", async () => {
    expect(REQUEST_BODY_TIMEOUT_MS).toBe(30_000);
    vi.stubEnv("PAPERCLIP_REQUEST_BODY_TIMEOUT_MS", "0");
    vi.resetModules();
    expect((await import("../http/body-limits.js")).REQUEST_BODY_TIMEOUT_MS).toBe(0);
  });
});
