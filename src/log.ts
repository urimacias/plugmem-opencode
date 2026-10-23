import type { LogLevel } from "./config.js";

export type Logger = (message: string, err?: unknown) => void;

/**
 * Minimal stderr logger. Deliberately not console.log: OpenCode owns
 * stdout for the TUI, and a stray line corrupts the interface.
 */
export function makeLogger(level: LogLevel): Logger {
  if (level === "silent") return () => {};
  return (message, err) => {
    const suffix =
      err === undefined
        ? ""
        : ` :: ${err instanceof Error ? err.message : String(err)}`;
    if (level === "error" && err === undefined) return;
    process.stderr.write(`[plugmem-opencode] ${message}${suffix}\n`);
  };
}
