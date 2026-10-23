// Manual tools: plugmem_recall and plugmem_remember.
//
// Recall reuses the core's `doRecall` formatting so manual lookups return
// exactly the same block shape the automatic hooks inject. Writing is a
// direct structured insert, bypassing the promotion gate on purpose: when
// the user asks to remember something, it should be stored.
//
// OpenCode v2 registers tools through `ctx.tool.transform`, which runs
// synchronously, so each tool's `execute` closes over the same client and
// session-directory resolver the hooks use.

import type { Plugin as PluginNS } from "@opencode/plugin";
import type { JsonSchema } from "effect";
import { PlugMemClient, deriveRepoGraphId } from "./vendor/core/index.js";
import { doRecall } from "./vendor/core/recall.js";
import type { Logger } from "./log.js";

export interface ToolDeps {
  client: PlugMemClient;
  cwdFor(sessionID: string): Promise<string>;
  log: Logger;
}

const RECALL_CHAR_CAP = 3_000;

const RECALL_INPUT = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "What to look for, in natural language.",
    },
    graph: {
      type: "string",
      description:
        "Graph id override, e.g. 'user-facts'. Defaults to this repository's graph.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as unknown as JsonSchema.JsonSchema;

const REMEMBER_INPUT = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: "The memory itself, one self-contained statement.",
    },
    kind: {
      type: "string",
      enum: ["semantic", "procedural"],
      description:
        "semantic = a fact or convention (default). procedural = a how-to that solved a problem.",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Optional tags for later filtering.",
    },
    graph: {
      type: "string",
      description:
        "Graph id override, e.g. 'user-facts'. Defaults to this repository's graph.",
    },
  },
  required: ["text"],
  additionalProperties: false,
} as unknown as JsonSchema.JsonSchema;

export async function registerTools(
  ctx: PluginNS.Context,
  deps: ToolDeps,
): Promise<{ dispose(): Promise<void> }> {
  return ctx.tool.transform((tools) => {
    tools.add({
      name: "plugmem_recall",
      description:
        "Search long-term memory (PlugMem) for facts, conventions, and " +
        "debugging recipes learned in earlier sessions. Defaults to this " +
        "repository's memory graph.",
      input: RECALL_INPUT,
      execute: async (input, toolCtx) => {
        const args = (input ?? {}) as { query?: string; graph?: string };
        if (!args.query) {
          return { content: "plugmem_recall requires a non-empty query.", metadata: {} };
        }

        const cwd = await deps.cwdFor(toolCtx.sessionID);
        const graphId =
          args.graph ?? (await deriveRepoGraphId("opencode", cwd));

        try {
          await deps.client.ensureGraph(graphId);
        } catch (err) {
          deps.log(`ensureGraph(${graphId}) failed`, err);
        }

        const injection = await doRecall({
          client: deps.client,
          graphId,
          observation: args.query,
          charCap: RECALL_CHAR_CAP,
          blockTitle: "manual-recall",
          log: deps.log,
        });

        return {
          content: injection?.text ?? `No relevant memories in ${graphId}.`,
          metadata: { graph: graphId },
        };
      },
    });

    tools.add({
      name: "plugmem_remember",
      description:
        "Store a durable fact or procedure in long-term memory (PlugMem). " +
        "Use for project conventions, user preferences, and fixes worth " +
        "reusing. Written directly, without the promotion gate.",
      input: REMEMBER_INPUT,
      execute: async (input, toolCtx) => {
        const args = (input ?? {}) as {
          text?: string;
          kind?: "semantic" | "procedural";
          tags?: string[];
          graph?: string;
        };
        if (!args.text) {
          return {
            content: "plugmem_remember requires non-empty text.",
            metadata: {},
          };
        }

        const text = args.text;
        const cwd = await deps.cwdFor(toolCtx.sessionID);
        const graphId =
          args.graph ?? (await deriveRepoGraphId("opencode", cwd));
        const tags = args.tags ?? [];
        const kind = args.kind ?? "semantic";

        try {
          await deps.client.ensureGraph(graphId);
        } catch (err) {
          deps.log(`ensureGraph(${graphId}) failed`, err);
        }

        const inserted = await deps.client.insertMemories(graphId, {
          mode: "structured",
          ...(kind === "procedural"
            ? {
                procedural: [
                  {
                    subgoal: text.slice(0, 80),
                    procedural_memory: text,
                    source: "explicit",
                    confidence: 0.95,
                  },
                ],
              }
            : {
                semantic: [
                  {
                    semantic_memory: text,
                    tags,
                    source: "explicit",
                    confidence: 0.95,
                  },
                ],
              }),
        } as Parameters<PlugMemClient["insertMemories"]>[1]);

        const stats = inserted?.stats
          ? ` (${Object.entries(inserted.stats)
              .map(([key, value]) => `${key}=${value}`)
              .join(", ")})`
          : "";

        return {
          content: `Saved ${kind} memory to ${graphId}${stats}.`,
          metadata: { graph: graphId, kind },
        };
      },
    });
  });
}
