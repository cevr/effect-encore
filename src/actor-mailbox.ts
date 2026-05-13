/**
 * ActorMailbox — outbound dispatch surface for actor `.send()`.
 *
 * **Why this exists.** Encore's `OperationHandle.send` previously dispatched
 * through `Sharding.makeClient`, which routes via `Sharding.sendOutgoing` →
 * `notifyLocal` → `waitForEntityManager`. In producer-only hosts (no handler
 * registered for the entity), `notifyLocal` blocks until
 * `entityRegistrationTimeout` (15s default) and then dies with `Entity type
 * 'X' not registered`. This makes producer-only `.send()` impossible through
 * the public encore surface.
 *
 * **What this does.** A narrow Tag with one method (`send`). Two factories:
 *
 * - `fromConfig` requires only `MessageStorage`. Treats both
 *   `SaveResult.Success` and `SaveResult.Duplicate` as enqueued (mirror of
 *   upstream `Runners.notifyWith` semantics for fire-and-forget). No
 *   `notifyLocal`; the consumer's storage poll loop picks up the envelope
 *   on the next `entityMessagePollInterval` tick. Use this in producer-only
 *   and ops-only hosts.
 * - `fromSharding` requires full `Sharding`. Delegates to
 *   `sharding.sendOutgoing(request, true)`. Use in consumer hosts that
 *   already host the cluster runtime.
 *
 * Both factories MUST accept the same `Message.OutgoingRequest` shape.
 * Caller-side request building (in `OperationHandle.send`) does not vary
 * between hosts — only the Tag's wired layer does.
 *
 * **`fromConfig` cross-process correctness.** Pinned by the upstream
 * consumer storage loop: `Sharding.unprocessedMessages(acquiredShards)`
 * polls storage on `entityMessagePollInterval` cadence and routes each
 * envelope to the registered entity manager. `notifyLocal` is an
 * acceleration path, not the only delivery mechanism. Tradeoff: latency
 * bounded by `entityMessagePollInterval`, not correctness.
 */
import type { Rpc } from "effect/unstable/rpc";
import { ClusterSchema, type Message, MessageStorage, Sharding } from "effect/unstable/cluster";
import type {
  MailboxFull,
  AlreadyProcessingMessage,
  PersistenceError,
} from "effect/unstable/cluster/ClusterError";
import { Context, Data, Effect, Layer } from "effect";

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * Thrown when storage rejects the request beyond the recoverable
 * `MalformedMessage` case. Mirrors `PersistenceError` semantics.
 */
export class MailboxError extends Data.TaggedError("effect-encore/actor-mailbox/MailboxError")<{
  readonly cause: unknown;
}> {}

// ─── Shape ──────────────────────────────────────────────────────────────────

/* eslint-disable typescript-eslint/no-explicit-any -- Message.OutgoingRequest is type-erased at the dispatch surface */
export interface ActorMailboxShape {
  readonly send: (
    request: Message.OutgoingRequest<Rpc.Any>,
  ) => Effect.Effect<
    void,
    MailboxError | PersistenceError | MailboxFull | AlreadyProcessingMessage
  >;
}
/* eslint-enable typescript-eslint/no-explicit-any */

// ─── Tag ────────────────────────────────────────────────────────────────────

export class ActorMailbox extends Context.Service<ActorMailbox, ActorMailboxShape>()(
  "effect-encore/actor-mailbox/ActorMailbox",
) {}

// ─── Layers ─────────────────────────────────────────────────────────────────

/**
 * Storage-only mailbox. Calls `MessageStorage.saveRequest`; treats
 * `SaveResult.Success` and `SaveResult.Duplicate` as enqueued (no error).
 *
 * **Persisted gate.** Upstream `Sharding.sendOutgoing` only routes through
 * storage when the rpc carries the `Persisted` annotation; non-persisted
 * requests go live-only and would never be observed by a consumer's storage
 * poll loop. Storage-only `fromConfig` therefore rejects non-persisted
 * requests loudly rather than silently durable-enqueueing them — that would
 * diverge from the platform contract and surprise callers.
 *
 * Use in producer-only / ops-only hosts that must NOT register entity
 * managers.
 */
const fromConfig: Layer.Layer<ActorMailbox, never, MessageStorage.MessageStorage> = Layer.effect(
  ActorMailbox,
  Effect.gen(function* () {
    const storage = yield* MessageStorage.MessageStorage;

    return {
      send: (request) =>
        Effect.gen(function* () {
          /* eslint-disable typescript-eslint/no-explicit-any -- Rpc.Any erases annotations; mirror of upstream Sharding sendOutgoing persisted gate */
          const isPersisted = Context.get(
            (request.rpc as any).annotations,
            ClusterSchema.Persisted,
          );
          /* eslint-enable typescript-eslint/no-explicit-any */
          if (!isPersisted) {
            return yield* new MailboxError({
              cause: new Error(
                `effect-encore: ActorMailboxLayer.fromConfig refuses to dispatch non-persisted rpc "${String(request.envelope.tag)}". Storage-only mailboxes can only enqueue persisted requests; live-only rpcs require ActorMailboxLayer.fromSharding.`,
              ),
            });
          }
          const result = yield* storage
            .saveRequest(request)
            .pipe(
              Effect.catchTag("MalformedMessage", (cause) =>
                Effect.fail(new MailboxError({ cause })),
              ),
            );
          // SaveResult.Success and SaveResult.Duplicate are both "enqueued"
          // for fire-and-forget .send. Discard-only callers don't resume
          // reply handlers, so Duplicate is a no-op on the receive side too
          // (the consumer's storage poll loop already routes the original
          // request). Mirror of upstream Runners.notifyWith for the
          // OutgoingRequest branch.
          void result;
        }),
    };
  }),
);

/**
 * Sharding-delegating mailbox. Calls `sharding.sendOutgoing(request, true)`
 * — the existing consumer-side dispatch path.
 *
 * Use in consumer hosts that already host the full cluster runtime.
 */
const fromSharding: Layer.Layer<ActorMailbox, never, Sharding.Sharding> = Layer.effect(
  ActorMailbox,
  Effect.gen(function* () {
    const sharding = yield* Sharding.Sharding;

    return {
      send: (request) =>
        sharding
          .sendOutgoing(request, true)
          .pipe(Effect.catchTag("AlreadyProcessingMessage", () => Effect.void)),
    };
  }),
);

/**
 * Layer factories. Layers are exposed as a namespace alongside the Tag.
 *
 * @example
 * ```ts
 * import { ActorMailbox, ActorMailboxLayer } from "effect-encore";
 *
 * // producer-only / ops-only host:
 * Layer.provide(ActorMailboxLayer.fromConfig)
 *
 * // consumer host with full Sharding:
 * Layer.provide(ActorMailboxLayer.fromSharding)
 * ```
 */
export const ActorMailboxLayer = {
  fromConfig,
  fromSharding,
} as const;
