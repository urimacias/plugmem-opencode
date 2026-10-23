import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import plugmem from "../src/index.ts";

const options = {
  // Port 9 is "discard": the fire-and-forget health check fails fast
  // without touching a real PlugMem instance.
  baseUrl: "http://127.0.0.1:9",
  timeoutMs: 50,
  maxRetries: 0,
  logLevel: "silent" as const,
};

beforeEach(() => {
  // Keep the developer's real ~/.config/opencode/plugmem.json out of tests.
  process.env.PLUGMEM_OPENCODE_CONFIG = join(
    tmpdir(),
    "plugmem-opencode-missing-config.json",
  );
});

function fakeCtx(pluginOptions: Record<string, unknown> = {}) {
  const sessionHooks = new Map<string, (event: any) => unknown>();
  const toolHooks = new Map<string, (event: any) => unknown>();
  const tools: Array<{ name: string }> = [];

  const ctx = {
    location: { directory: "/tmp/plugmem-opencode-test" },
    options: pluginOptions,
    session: {
      get: async () => ({
        location: { directory: "/tmp/plugmem-opencode-test" },
      }),
      hook: async (name: string, callback: (event: any) => unknown) => {
        sessionHooks.set(name, callback);
        return {
          dispose: async () => {
            sessionHooks.delete(name);
          },
        };
      },
    },
    tool: {
      hook: async (name: string, callback: (event: any) => unknown) => {
        toolHooks.set(name, callback);
        return {
          dispose: async () => {
            toolHooks.delete(name);
          },
        };
      },
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (tool: { name: string }) => tools.push(tool),
        });
        return {
          dispose: async () => {
            tools.length = 0;
          },
        };
      },
    },
  };

  return { ctx, sessionHooks, toolHooks, tools };
}

describe("plugin definition", () => {
  it("exports the OpenCode v2 module shape", () => {
    expect(plugmem.id).toBe("opencode.plugmem");
    expect(typeof plugmem.setup).toBe("function");
  });
});

describe("setup", () => {
  it("registers the session and tool hooks", async () => {
    const { ctx, sessionHooks, toolHooks } = fakeCtx(options);
    const cleanup = await plugmem.setup(ctx as any);

    expect([...sessionHooks.keys()].sort()).toEqual([
      "compaction",
      "context",
      "prompt",
    ]);
    expect([...toolHooks.keys()].sort()).toEqual([
      "execute.after",
      "execute.before",
    ]);
    expect(typeof cleanup).toBe("function");

    await (cleanup as () => Promise<void>)();
    expect(sessionHooks.size).toBe(0);
    expect(toolHooks.size).toBe(0);
  });

  it("registers both manual tools", async () => {
    const { ctx, tools } = fakeCtx({ ...options, tools: true });
    await plugmem.setup(ctx as any);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "plugmem_recall",
      "plugmem_remember",
    ]);
  });

  it("omits tools when disabled", async () => {
    const { ctx, tools } = fakeCtx({ ...options, tools: false });
    await plugmem.setup(ctx as any);
    expect(tools).toEqual([]);
  });

  it("registers nothing when disabled", async () => {
    const { ctx, sessionHooks } = fakeCtx({ ...options, enabled: false });
    await plugmem.setup(ctx as any);
    expect(sessionHooks.size).toBe(0);
  });

  it("does not inject when nothing was recalled", async () => {
    const { ctx, sessionHooks } = fakeCtx(options);
    await plugmem.setup(ctx as any);

    const output = { system: [{ type: "text", text: "base" }] };
    await sessionHooks.get("context")!({
      sessionID: "ses_unknown",
      system: output.system,
    });

    expect(output.system).toEqual([{ type: "text", text: "base" }]);
  });
});
