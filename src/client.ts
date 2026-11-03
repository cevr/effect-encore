import { Context, Effect, Layer, Predicate } from "effect";
import {
  type Entity as ClusterEntity,
  type EntityAddress,
  MessageStorage,
  type Sharding,
  type ShardingConfig,
  Snowflake,
} from "effect/cluster";
import type {
  AlreadyProcessingMessage,
  EntityNotAssignedToRunner,
  MailboxFull,
  MalformedMessage,
  PersistenceError,
} from "effect/cluster/ClusterError";
import type { Rpc, RpcClient } from "effect/rpc";
import {
  ActorAddressResolver,
  ActorAddressResolverLayer,
  type ActorAddressResolverService,
} from "./actor-address-resolver.js";
import {
  ActorMailbox,
  ActorMailboxLayer,
  MailboxError,
  type ActorMailboxService,
} from "./actor-mailbox.js";
import { ActorSenderLayer } from "./actor-sender.js";
import { ActorDefect } from "./actor-defect.js";
import { type ExecId, type PeekResult, type ReplyDefs, peekStoredReply } from "./receipt.js";
import type { Invocation } from "./internal/invocation-compiler.js";
import { compileOutgoingRequest } from "./internal/invocation-compiler.js";
import { MessageDeletion } from "./storage.js";

function eraseTestRpcEffect<Candidate>(candidate: Candidate): Effect.Effect<void>;
function eraseTestRpcEffect<Candidate>(candidate: Candidate): unknown {
  if (!Effect.isEffect(candidate)) {
    return Effect.die(
      new ActorDefect({
        message: "effect-encore test mailbox: rpc did not return an Effect",
      }),
    );
  }
  return candidate;
}

export const resolveEntityAddress = (
  resolver: ActorAddressResolverService,
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- entity Rpcs erased
  entity: ClusterEntity.Entity<string, any>,
  actorId: string,
): EntityAddress.EntityAddress => resolver.resolveEntity(entity, actorId);

export const makeTestMailboxImpl = (
  makeClient: (entityId: string) => Effect.Effect<RpcClient.RpcClient<Rpc.Any, never>>,
): ActorMailboxService => ({
  send: (request) =>
    Effect.gen(function* () {
      const envelope = request.envelope;
      const entityId: string = envelope.address.entityId;
      const tag = envelope.tag;
      const payload = envelope.payload;
      const rpcClient = yield* makeClient(entityId);
      const fn = Reflect.get(rpcClient, tag);
      if (!Predicate.isFunction(fn)) {
        return yield* new MailboxError({
          cause: new ActorDefect({
            message: `effect-encore test mailbox: unknown rpc "${String(tag)}" on entity "${String(envelope.address.entityType)}"`,
          }),
        });
      }
      const result = Reflect.apply(fn, rpcClient, [payload, { discard: true }]);
      yield* eraseTestRpcEffect(result);
    }),
});

export type ClientSendError =
  | MailboxError
  | PersistenceError
  | MailboxFull
  | AlreadyProcessingMessage
  | EntityNotAssignedToRunner;

/* eslint-disable typescript-eslint/no-explicit-any -- entity Rpcs are type-erased at the transport surface */
export interface ClientService {
  readonly resolve: (
    entity: ClusterEntity.Entity<string, any>,
    entityId: string,
  ) => EntityAddress.EntityAddress;
  readonly send: (invocation: Invocation) => Effect.Effect<ExecId, ClientSendError>;
  readonly peek: (
    entity: ClusterEntity.Entity<string, any>,
    execId: string,
    definitions?: ReplyDefs,
  ) => Effect.Effect<PeekResult, PersistenceError | MalformedMessage>;
  readonly deleteInvocation: (invocation: Invocation) => Effect.Effect<void, PersistenceError>;
  readonly flush: (
    entity: ClusterEntity.Entity<string, any>,
    actorId: string,
  ) => Effect.Effect<void, PersistenceError>;
  readonly redeliver: (
    entity: ClusterEntity.Entity<string, any>,
    actorId: string,
  ) => Effect.Effect<void, PersistenceError>;
  readonly pruneWorkflow: (
    workflow: Parameters<ActorAddressResolverService["resolveWorkflow"]>[0],
    executionId: string,
  ) => Effect.Effect<void, PersistenceError>;
  readonly withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}
/* eslint-enable typescript-eslint/no-explicit-any */

export class Client extends Context.Service<Client, ClientService>()("effect-encore/client") {}

const makeClientService: Effect.Effect<
  ClientService,
  never,
  ActorMailbox | ActorAddressResolver | Snowflake.Generator | MessageStorage.MessageStorage
> = Effect.gen(function* () {
  const mailbox = yield* ActorMailbox;
  const resolver = yield* ActorAddressResolver;
  const snowflakeGen = yield* Snowflake.Generator;
  const storage = yield* MessageStorage.MessageStorage;
  const deletion = yield* Effect.serviceOption(MessageDeletion);
  const resolve: ClientService["resolve"] = (entity, entityId) =>
    resolveEntityAddress(resolver, entity, entityId);

  return Client.of({
    resolve,
    send: (invocation) =>
      Effect.gen(function* () {
        const address = resolve(invocation.entity, invocation.identity.entityId);
        const request = yield* compileOutgoingRequest(invocation, address, snowflakeGen);
        yield* mailbox.send(request);
        return invocation.identity.execId;
      }),
    peek: (entity, execId, definitions) =>
      peekStoredReply(entity, execId, definitions).pipe(
        Effect.provideService(MessageStorage.MessageStorage, storage),
        Effect.provideService(ActorAddressResolver, resolver),
      ),
    deleteInvocation: (invocation) => {
      if (deletion._tag === "None") {
        return Effect.die(
          new ActorDefect({
            message:
              "effect-encore: this Client storage adapter does not support single-invocation deletion",
          }),
        );
      }
      return deletion.value.deleteInvocation({
        address: resolve(invocation.entity, invocation.identity.entityId),
        tag: invocation.tag,
        primaryKey: invocation.identity.primaryKey,
      });
    },
    flush: (entity, actorId) =>
      storage.clearAddress(resolveEntityAddress(resolver, entity, actorId)),
    redeliver: (entity, actorId) =>
      storage.resetAddress(resolveEntityAddress(resolver, entity, actorId)),
    pruneWorkflow: (workflow, executionId) =>
      storage
        .clearAddress(resolver.resolveWorkflow(workflow, executionId))
        .pipe(
          Effect.andThen(
            storage.clearAddress(resolver.resolveWorkflowClock(workflow, executionId)),
          ),
        ),
    withTransaction: storage.withTransaction,
  });
});

export const clientServiceLayer: Layer.Layer<
  Client,
  never,
  ActorMailbox | ActorAddressResolver | Snowflake.Generator | MessageStorage.MessageStorage
> = Layer.effect(Client, makeClientService);

const clientLayer = clientServiceLayer;

const fromConfig: Layer.Layer<
  Client,
  never,
  MessageStorage.MessageStorage | ShardingConfig.ShardingConfig
> = clientLayer.pipe(Layer.provideMerge(ActorSenderLayer.layer));

const fromSharding: Layer.Layer<Client, never, Sharding.Sharding | MessageStorage.MessageStorage> =
  clientLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ActorMailboxLayer.fromSharding,
        ActorAddressResolverLayer.fromSharding,
        Snowflake.layerGenerator,
      ),
    ),
  );

const memory: Layer.Layer<Client> = clientLayer.pipe(
  Layer.provideMerge(ActorSenderLayer.layerMemory),
);

const test: Layer.Layer<Client, never, ActorMailbox | ShardingConfig.ShardingConfig> =
  clientLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ActorAddressResolverLayer.fromConfig,
        MessageStorage.layerMemory,
        Snowflake.layerGenerator,
      ),
    ),
  );

export const layer = {
  fromConfig,
  fromSharding,
  memory,
  test,
};
