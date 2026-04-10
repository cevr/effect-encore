import { describe, it } from "bun:test";

describe("Actor.workflow", () => {
  it.todo("defines a workflow-backed actor with payload/success/error schemas", () => {});
  it.todo("idempotencyKey generates deterministic executionId", () => {});
});

describe("Workflow Ref.call", () => {
  it.todo("executes workflow and blocks until Complete — returns success value", () => {});
  it.todo("surfaces workflow errors in the error channel", () => {});
  it.todo("retries through Suspended states until Complete", () => {});
});

describe("Workflow Ref.cast", () => {
  it.todo("executes with discard: true — returns WorkflowReceipt with executionId", () => {});
  it.todo("duplicate cast with same idempotencyKey is idempotent", () => {});
});

describe("Workflow peek", () => {
  it.todo("returns Pending when workflow has not started", () => {});
  it.todo("returns Pending when workflow is Suspended", () => {});
  it.todo("returns Success/Failure when workflow is Complete", () => {});
  it.todo("uses workflow.poll(executionId) under the hood", () => {});
});

describe("DurableDeferred integration", () => {
  it.todo("ref.token(deferred) returns a Token for external completion", () => {});
  it.todo("DurableDeferred.succeed resumes a suspended workflow", () => {});
  it.todo("token can be generated before workflow starts via tokenFromPayload", () => {});
});

describe("Workflow lifecycle", () => {
  it.todo("ref.interrupt() signals workflow interruption", () => {});
  it.todo("ref.resume() resumes a suspended workflow", () => {});
  it.todo("activities checkpoint — replay skips completed steps", () => {});
});
