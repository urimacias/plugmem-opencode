// OpenCode v2 adapter for PlugMem.
//
// OpenCode 2.x plugins are modules exporting `{ id, setup }`. Inside
// setup we register runtime hooks; the ones that matter here:
//
//   session.hook("prompt")     -> user prompt: record + recall
//   session.hook("context")    -> before dispatch: inject recall, lazy
//                                 session-start recall, schedule promotion
//   session.hook("compaction") -> flush candidates, re-inject memory
//   tool.hook("execute.before")-> promotion gate: track pending calls
//   tool.hook("execute.after") -> promotion gate: success/failure
//   tool.transform(...)        -> plugmem_recall / plugmem_remember
//
// Every callback is wrapped: a PlugMem outage degrades to "no memory"
// instead of breaking the session.

import type { Plugin as PluginNS } from "@opencode/plugin";
import {
  createCore,
  deriveRepoGraphId,
  resolveConfig as resolveCoreConfig,
  type CoreCallbacks,
} from "./vendor/core/index.js";
import { RecallClient } from "./client.js";
import {
  resolveConfig,
  type PluginOptions as PlugMemOptions,
} from "./config.js";
import { SessionStates } from "./state.js";
import { makeLogger, type Logger } from "./log.js";
import { registerTools } from "./tools.js";

const HARNESS = "opencode" as const;
const MEMORY_TAG = "plugmem-memory";

const wrap = (blocks: string[]): string =>
  `<${MEMORY_TAG}>\n${blocks.join("\n\n")}\n</${MEMORY_TAG}>`;

const plugmem: PluginNS.Plugin = {
  id: "opencode.plugmem",

  async setup(ctx) {
    const cfg = resolveConfig((ctx.options ?? {}) as PlugMemOptions);
    if (!cfg.enabled) return;

    const log: Logger = makeLogger(cfg.logLevel);

    const coreConfig = resolveCoreConfig({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
      maxRetries: cfg.maxRetries,
    });
    const client = new RecallClient(coreConfig, cfg.planner);
    const states = new SessionStates();

    const cwdBySession = new Map<string, string>();
    const started = new Set<string>();
    const pending = new Map<string, string[]>();
    const promoting = new Set<string>();
    const lastPromotion = new Map<string, number>();
    const disposers: Array<{ dispose(): Promise<void> }> = [];

    const cwdFor = async (sessionID: string): Promise<string> => {
      const cached = cwdBySession.get(sessionID);
      if (cached) return cached;
      try {
        const info = await ctx.session.get({ sessionID });
        const dir = info?.location?.directory;
        if (dir) {
          cwdBySession.set(sessionID, dir);
          return dir;
        }
      } catch (err) {
        log(`session lookup failed for ${sessionID}`, err);
      }
      return ctx.location.directory;
    };

    const stash = (sessionID: string, text: string): void => {
      if (!text) return;
      const blocks = pending.get(sessionID) ?? [];
      blocks.push(text);
      // Bound the stash: a session that never dispatches must not grow.
      while (blocks.length > 4) blocks.shift();
      pending.set(sessionID, blocks);
    };

    const core: CoreCallbacks = createCore({
      config: {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        timeoutMs: cfg.timeoutMs,
        maxRetries: cfg.maxRetries,
      },
      sessionStartRecall: cfg.sessionStartRecall,
      userPromptRecall: cfg.userPromptRecall,
      toolFamilyRecall: cfg.toolFamilyRecall,
      state: (sessionID) => states.get(sessionID),
      client,
      log,
    });

    const ensureSessionStart = async (sessionID: string): Promise<void> => {
      if (started.has(sessionID)) return;
      started.add(sessionID);
      const cwd = await cwdFor(sessionID);
      const injection = await core.onSessionStart({
        harness: HARNESS,
        sessionId: sessionID,
        cwd,
        source: "startup",
      });
      if (injection?.text) stash(sessionID, injection.text);
    };

    // Promotion runs off the request path: /extract is an LLM call and
    // must never delay a turn. One in flight per session, debounced.
    const schedulePromotion = (sessionID: string): void => {
      const now = Date.now();
      if (promoting.has(sessionID)) return;
      if (now - (lastPromotion.get(sessionID) ?? 0) < cfg.idleDebounceMs) {
        return;
      }
      lastPromotion.set(sessionID, now);
      promoting.add(sessionID);
      void cwdFor(sessionID)
        .then((cwd) =>
          core.onSessionEnd({
            harness: HARNESS,
            sessionId: sessionID,
            cwd,
            reason: "stop",
          }),
        )
        .catch((err) => log("promotion failed", err))
        .finally(() => promoting.delete(sessionID));
    };

    const track = (registration: { dispose(): Promise<void> }): void => {
      disposers.push(registration);
    };

    // Do not block plugin load on the service.
    void client
      .healthCheck()
      .then(() => log(`connected to ${cfg.baseUrl}`, undefined))
      .catch((err) => log(`service unreachable at ${cfg.baseUrl}`, err));

    if (!cfg.apiKey) {
      log(
        "no API key configured (set PLUGMEM_API_KEY or ~/.config/opencode/plugmem.json)",
      );
    }

    track(
      await ctx.session.hook("prompt", async (event) => {
        try {
          const prompt = event.prompt?.text?.trim() ?? "";
          if (!prompt) return;
          const injection = await core.onUserPrompt({
            harness: HARNESS,
            sessionId: event.sessionID,
            cwd: await cwdFor(event.sessionID),
            prompt,
          });
          if (injection?.text) stash(event.sessionID, injection.text);
        } catch (err) {
          log("prompt hook failed", err);
        }
      }),
    );

    track(
      await ctx.session.hook("context", async (event) => {
        try {
          await ensureSessionStart(event.sessionID);
          const blocks = pending.get(event.sessionID);
          if (blocks?.length) {
            pending.delete(event.sessionID);
            event.system.push({ type: "text", text: wrap(blocks) });
          }
          schedulePromotion(event.sessionID);
        } catch (err) {
          log("context hook failed", err);
        }
      }),
    );

    track(
      await ctx.session.hook("compaction", async (event) => {
        try {
          const cwd = await cwdFor(event.sessionID);
          // Persist what the gate holds before the transcript is replaced.
          await core.onPreCompact({
            harness: HARNESS,
            sessionId: event.sessionID,
            cwd,
          });
          const injection = await core.onSessionStart({
            harness: HARNESS,
            sessionId: event.sessionID,
            cwd,
            source: "compact",
          });
          if (injection?.text) {
            event.system.push({
              type: "text",
              text: wrap([injection.text]),
            });
            // The post-compaction context starts clean; re-inject later.
            stash(event.sessionID, injection.text);
          }
        } catch (err) {
          log("compaction hook failed", err);
        }
      }),
    );

    track(
      await ctx.tool.hook("execute.before", async (event) => {
        try {
          await core.onPreTool({
            harness: HARNESS,
            sessionId: event.sessionID,
            cwd: await cwdFor(event.sessionID),
            toolName: event.tool,
            toolInput: event.input,
            callId: String(event.id),
          });
        } catch (err) {
          log("tool.execute.before hook failed", err);
        }
      }),
    );

    track(
      await ctx.tool.hook("execute.after", async (event) => {
        try {
          const outcome = event.status === "completed" ? "success" : "failure";
          const raw =
            event.status === "completed"
              ? safeStringify(event.result)
              : `${event.error?.message ?? "tool error"}`;
          await core.onPostTool({
            harness: HARNESS,
            sessionId: event.sessionID,
            cwd: await cwdFor(event.sessionID),
            toolName: event.tool,
            toolInput: event.input,
            callId: String(event.id),
            // The gate only needs enough of the result to recognise a
            // fix; huge outputs are the main way this becomes a bomb.
            toolResult: raw.slice(0, 4_000),
            outcome,
          });
        } catch (err) {
          log("tool.execute.after hook failed", err);
        }
      }),
    );

    if (cfg.tools) {
      await registerTools(ctx, { client, cwdFor, log });
    }

    return async () => {
      for (const registration of disposers.reverse()) {
        await registration.dispose().catch(() => {});
      }
    };
  },
};

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export default plugmem;
