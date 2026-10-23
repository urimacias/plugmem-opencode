import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.ts";

const ENV_KEYS = [
  "PLUGMEM_OPENCODE_CONFIG",
  "PLUGMEM_BASE_URL",
  "PLUGMEM_API_KEY",
  "PLUGMEM_USER_ID",
  "PLUGMEM_OPENCODE_DISABLED",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.PLUGMEM_OPENCODE_CONFIG = join(
    mkdtempSync(join(tmpdir(), "plugmem-opencode-")),
    "plugmem.json",
  );
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
});

describe("resolveConfig", () => {
  it("falls back to localhost defaults", () => {
    const cfg = resolveConfig();
    expect(cfg.baseUrl).toBe("http://127.0.0.1:18080");
    expect(cfg.enabled).toBe(true);
    expect(cfg.tools).toBe(true);
    expect(cfg.timeoutMs).toBe(8_000);
    expect(cfg.promoteOnIdle).toBe(true);
  });

  it("reads the credentials file layer", () => {
    writeFileSync(
      process.env.PLUGMEM_OPENCODE_CONFIG!,
      JSON.stringify({ apiKey: "from-file", userId: "uri" }),
    );
    const cfg = resolveConfig();
    expect(cfg.apiKey).toBe("from-file");
  });

  it("lets environment override the file", () => {
    writeFileSync(
      process.env.PLUGMEM_OPENCODE_CONFIG!,
      JSON.stringify({ apiKey: "from-file", baseUrl: "http://file:1/api" }),
    );
    process.env.PLUGMEM_API_KEY = "from-env";
    process.env.PLUGMEM_BASE_URL = "http://env:2/api/";
    const cfg = resolveConfig();
    expect(cfg.apiKey).toBe("from-env");
    expect(cfg.baseUrl).toBe("http://env:2/api");
  });

  it("accepts a full API URL and strips the /api/v1 suffix", () => {
    const cfg = resolveConfig({ baseUrl: "http://127.0.0.1:18080/api/v1/" });
    expect(cfg.baseUrl).toBe("http://127.0.0.1:18080");
  });

  it("lets plugin options override everything", () => {
    process.env.PLUGMEM_API_KEY = "from-env";
    const cfg = resolveConfig({ apiKey: "from-options", tools: false });
    expect(cfg.apiKey).toBe("from-options");
    expect(cfg.tools).toBe(false);
  });

  it("honours the kill switch", () => {
    process.env.PLUGMEM_OPENCODE_DISABLED = "1";
    expect(resolveConfig().enabled).toBe(false);
  });

  it("accepts false to disable a recall trigger", () => {
    const cfg = resolveConfig({ userPromptRecall: false });
    expect(cfg.userPromptRecall).toBe(false);
  });
});
