import { describe, it } from "vitest";

// TODO: test processJob and claimOne with a mock db
// Need to figure out how to mock the pg Pool for unit tests — for now
// the integration test covers the happy path end-to-end.

describe("worker", () => {
  it.todo("claims a queued job and marks it processing");
  it.todo("skips locked jobs (no double-claim)");
  it.todo("retries on transient errors up to max_attempts");
  it.todo("immediately fails on bad_input errors");
});
