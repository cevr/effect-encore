/**
 * Internal defect signal.
 *
 * These are contract violations, not recoverable failures: a reserved key used
 * as an operation name, an rpc tag missing from a compiled entity protocol. The
 * type system already rejects each of them at the call site; this class is the
 * runtime backstop for untyped callers, so it is raised as a defect (thrown
 * from sync builders, `Effect.die` inside Effect code) rather than a typed
 * error channel.
 */

import { Data } from "effect";

export class ActorDefect extends Data.TaggedError("effect-encore/actor-defect/ActorDefect")<{
  readonly message: string;
}> {}
