import { describe, expect, it } from "vitest";
import { SessionStates } from "../src/state.ts";

describe("SessionStates", () => {
  it("stores and returns the same state per session", async () => {
    const states = new SessionStates();
    const a = states.get("a");
    await a.set("k", 1);
    expect(await states.get("a").get("k")).toBe(1);
    expect(await states.get("b").get("k")).toBeUndefined();
  });

  it("deletes a session", async () => {
    const states = new SessionStates();
    await states.get("a").set("k", 1);
    states.delete("a");
    expect(states.size).toBe(0);
    expect(await states.get("a").get("k")).toBeUndefined();
  });

  it("evicts the oldest session past the cap", async () => {
    const states = new SessionStates();
    for (let i = 0; i < 64; i++) {
      await states.get(`s${i}`).set("k", i);
    }
    expect(states.size).toBe(64);
    await states.get("s64").set("k", 64);
    expect(states.size).toBe(64);
    // s0 was the oldest and is gone, so its state is fresh.
    expect(await states.get("s0").get("k")).toBeUndefined();
  });
});
