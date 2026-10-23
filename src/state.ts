// Per-session in-memory state required by the core's promotion gate
// (failure→success pairing and correction detection live across events).
//
// OpenCode plugins run in one long-lived process, so memory is enough.
// Entries are dropped when a session is deleted, and the map is capped so
// a long-running server cannot grow without bound.

import type { SessionState } from "./vendor/core/index.js";

const MAX_SESSIONS = 64;

class MemorySessionState implements SessionState {
  private readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }
}

export class SessionStates {
  private readonly states = new Map<string, MemorySessionState>();

  get(sessionID: string): SessionState {
    let state = this.states.get(sessionID);
    if (!state) {
      if (this.states.size >= MAX_SESSIONS) {
        const oldest = this.states.keys().next().value;
        if (oldest !== undefined) this.states.delete(oldest);
      }
      state = new MemorySessionState();
      this.states.set(sessionID, state);
    }
    return state;
  }

  delete(sessionID: string): void {
    this.states.delete(sessionID);
  }

  get size(): number {
    return this.states.size;
  }
}
