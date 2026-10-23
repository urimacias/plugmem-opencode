// Configuration resolution for the OpenCode adapter.
//
// Precedence (highest wins):
//   1. plugin options in opencode.jsonc
//   2. environment variables
//   3. ~/.config/opencode/plugmem.json   (chmod 600 recommended)
//   4. defaults
//
// The file layer exists so the API key does not have to live in a
// world-readable config.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LogLevel = "silent" | "error" | "info" | "debug";

export interface SessionStartRecallOptions {
  enabled?: boolean;
  query?: string;
  charCap?: number;
  minConfidence?: number;
}

export interface UserPromptRecallOptions {
  enabled?: boolean;
  charCap?: number;
  minPromptLength?: number;
  minConfidence?: number;
}

export interface ToolFamilyRecallOptions {
  enabled?: boolean;
  mapping?: Record<string, string>;
  charCap?: number;
}

export interface PluginOptions {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Register the plugmem_recall / plugmem_remember tools. Default true. */
  tools?: boolean;
  /**
   * Ask the server to run its LLM planner on recall. Default false:
   * planning adds ~40 s per recall on a free-tier LLM and the adapter
   * only needs observation-based retrieval.
   */
  planner?: boolean;
  sessionStartRecall?: SessionStartRecallOptions | false;
  userPromptRecall?: UserPromptRecallOptions | false;
  toolFamilyRecall?: ToolFamilyRecallOptions | false;
  /** Run the promotion gate when a session goes idle (debounced). */
  promoteOnIdle?: boolean;
  idleDebounceMs?: number;
  logLevel?: LogLevel;
}

export interface ResolvedConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  maxRetries: number;
  tools: boolean;
  planner: boolean;
  sessionStartRecall: SessionStartRecallOptions | false;
  userPromptRecall: UserPromptRecallOptions | false;
  toolFamilyRecall: ToolFamilyRecallOptions | false;
  promoteOnIdle: boolean;
  idleDebounceMs: number;
  logLevel: LogLevel;
}

const DEFAULTS = {
  // The core appends /api/v1/... to this, so it must not include it.
  baseUrl: "http://127.0.0.1:18080",
  // Deliberately short: a slow memory service must never stall a turn.
  timeoutMs: 8_000,
  maxRetries: 1,
  tools: true,
  planner: false,
  promoteOnIdle: true,
  idleDebounceMs: 60_000,
  logLevel: "info" as LogLevel,
};

/**
 * The core builds request paths as `${baseUrl}/api/v1/...`. People
 * reasonably paste the full API URL, so accept both shapes.
 */
export function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}

export function configPath(): string {
  return (
    process.env.PLUGMEM_OPENCODE_CONFIG ||
    join(homedir(), ".config", "opencode", "plugmem.json")
  );
}

function readFileLayer(): PluginOptions {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as PluginOptions;
  } catch {
    return {};
  }
}

function envLayer(): PluginOptions {
  const out: PluginOptions = {};
  const baseUrl = process.env.PLUGMEM_BASE_URL;
  const apiKey = process.env.PLUGMEM_API_KEY;
  if (baseUrl) out.baseUrl = baseUrl;
  if (apiKey) out.apiKey = apiKey;
  if (process.env.PLUGMEM_OPENCODE_DISABLED === "1") out.enabled = false;
  if (process.env.PLUGMEM_OPENCODE_PLANNER === "1") out.planner = true;
  return out;
}

function pick<T>(...values: Array<T | undefined>): T | undefined {
  for (const v of values) if (v !== undefined) return v;
  return undefined;
}

export function resolveConfig(options: PluginOptions = {}): ResolvedConfig {
  const file = readFileLayer();
  const env = envLayer();

  const baseUrl =
    pick(options.baseUrl, env.baseUrl, file.baseUrl) ?? DEFAULTS.baseUrl;

  return {
    enabled:
      pick(options.enabled, env.enabled, file.enabled) ?? true,
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey: pick(options.apiKey, env.apiKey, file.apiKey),
    timeoutMs: pick(options.timeoutMs, file.timeoutMs) ?? DEFAULTS.timeoutMs,
    maxRetries:
      pick(options.maxRetries, file.maxRetries) ?? DEFAULTS.maxRetries,
    tools: pick(options.tools, file.tools) ?? DEFAULTS.tools,
    planner: pick(options.planner, env.planner, file.planner) ?? DEFAULTS.planner,
    sessionStartRecall: pick(
      options.sessionStartRecall,
      file.sessionStartRecall,
    ) ?? {},
    userPromptRecall: pick(
      options.userPromptRecall,
      file.userPromptRecall,
    ) ?? {},
    toolFamilyRecall: pick(
      options.toolFamilyRecall,
      file.toolFamilyRecall,
    ) ?? {},
    promoteOnIdle:
      pick(options.promoteOnIdle, file.promoteOnIdle) ?? DEFAULTS.promoteOnIdle,
    idleDebounceMs:
      pick(options.idleDebounceMs, file.idleDebounceMs) ??
      DEFAULTS.idleDebounceMs,
    logLevel: pick(options.logLevel, file.logLevel) ?? DEFAULTS.logLevel,
  };
}
