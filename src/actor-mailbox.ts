import type { Rpc } from "effect/rpc";
import { ClusterSchema, type Message, MessageStorage, Sharding } from "effect/cluster";
import type {
  MailboxFull,
  AlreadyProcessingMessage,
  EntityNotAssignedToRunner,
  PersistenceError,
} from "effect/cluster/ClusterError";
import { Context, Data, Effect, Layer } from "effect";
import { ActorDefect } from "./actor-defect.js";

export class MailboxError extends Data.TaggedError("effect-encore/actor-mailbox/MailboxError")<{
  readonly cause: unknown;
}> {}

/* eslint-disable typescript-eslint/no-explicit-any -- Message.OutgoingRequest is type-erased at the dispatch surface */
export interface ActorMailboxService {
  readonly send: (
    request: Message.OutgoingRequest<Rpc.Any>,
  ) => Effect.Effect<
    void,
    | MailboxError
    | PersistenceError
    | MailboxFull
    | AlreadyProcessingMessage
    | EntityNotAssignedToRunner
  >;
}
/* eslint-enable typescript-eslint/no-explicit-any */

export class ActorMailbox extends Context.Service<ActorMailbox, ActorMailboxService>()(
  "effect-encore/actor-mailbox/ActorMailbox",
) {}

const fromConfig: Layer.Layer<ActorMailbox, never, MessageStorage.MessageStorage> = Layer.effect(
  ActorMailbox,
  Effect.gen(function* () {
    const storage = yield* MessageStorage.MessageStorage;

    return ActorMailbox.of({
      send: (request) =>
        Effect.gen(function* () {
          const isPersisted = Context.get(request.rpc.annotations, ClusterSchema.Persisted);
          if (!isPersisted) {
            return yield* new MailboxError({
              cause: new ActorDefect({
                message: `effect-encore: ActorMailboxLayer.fromConfig refuses to dispatch non-persisted rpc "${String(request.envelope.tag)}". Storage-only mailboxes can only enqueue persisted requests; live-only rpcs require ActorMailboxLayer.fromSharding.`,
              }),
            });
          }
          const result = yield* storage
            .saveRequest(request)
            .pipe(
              Effect.catchTag("MalformedMessage", (cause) =>
                Effect.fail(new MailboxError({ cause })),
              ),
            );
          void result;
        }),
    });
  }),
);

const fromSharding: Layer.Layer<ActorMailbox, never, Sharding.Sharding> = Layer.effect(
  ActorMailbox,
  Effect.gen(function* () {
    const sharding = yield* Sharding.Sharding;

    return ActorMailbox.of({
      send: (request) =>
        sharding
          .sendOutgoing(request, true)
          .pipe(Effect.catchTag("AlreadyProcessingMessage", () => Effect.void)),
    });
  }),
);

export const ActorMailboxLayer = {
  fromConfig,
  fromSharding,
};
