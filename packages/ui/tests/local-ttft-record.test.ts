import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLocalTtftRecord,
  type LocalTtftPending,
} from "../src/v4/telemetry/localTtftRecord.js";

test("local TTFT records first visible output from request to content frame", () => {
  const observationId = "00000000-0000-4000-8000-000000000202";
  const pending: LocalTtftPending = {
    context: { version: 1, observationId },
    workspace: "/workspace",
    start: 1_000,
    wallStart: 1_000,
    checkpointRevision: 0,
    dispatch: 1_100,
    commandId: "command-1",
    sessionId: "session-1",
    lastSeq: -1,
    sendMode: "idle",
    visibility: "foreground",
    visibilityChanges: [{ at: 1_000, foreground: true }],
    confirmations: [],
    rows: new Map(),
    facts: {
      version: 1,
      observationId,
      instanceId: "cli-1",
      commandId: "command-1",
      sessionId: "session-1",
      productTurnId: "turn-1",
      receivedAt: 1_200,
      admittedAt: 1_200,
      executionAt: 1_300,
      requestAt: 1_400,
      outputAt: 5_000,
      outputKind: "text",
    },
    first: "text",
    firstAt: 6_000,
    closed: true,
    outcome: "success",
  };

  const record = buildLocalTtftRecord(pending, "first_output", "success", 6_000, 6_000);
  assert.equal(record.kind, "first_output");
  assert.equal(record.start, 1_000);
  assert.equal(record.end, 6_000);
  assert.equal(record.firstOutputKind, "text");
  assert.deepEqual(
    record.intervals.find((interval) => interval.stage === "model_request"),
    { stage: "model_request", start: 1_400, end: 5_000, source: "cli" },
  );
});
