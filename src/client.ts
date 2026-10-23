// Client wrapper that asks PlugMem to skip its LLM planner.
//
// /retrieve runs an LLM planner when `auto_plan` is true (the server
// default). That costs a full generation per recall: ~43 s against the
// free-tier LLM used in the reference setup. With `auto_plan: false` the
// same query returned in 80 ms, using the observation embedding only.
//
// Servers that predate the `auto_plan` field ignore it (Pydantic drops
// unknown fields), so this stays backward compatible: it is a latency
// optimisation, not a requirement.

import { PlugMemClient } from "./vendor/core/client.js";
import type { ResolvedCoreConfig } from "./vendor/core/config.js";
import type { RetrieveRequest, RetrieveResponse } from "./vendor/core/types.js";

type WithPlanner = RetrieveRequest & { auto_plan?: boolean };

export class RecallClient extends PlugMemClient {
  constructor(
    config: ResolvedCoreConfig,
    private readonly autoPlan: boolean,
  ) {
    super(config);
  }

  override async retrieve(
    graphId: string,
    body: RetrieveRequest,
  ): Promise<RetrieveResponse> {
    const payload: WithPlanner = { ...body, auto_plan: this.autoPlan };
    return super.retrieve(graphId, payload);
  }
}
