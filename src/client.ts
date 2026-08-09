/**
 * `Client` — the topology-agnostic transport SEAM for talking to an actor.
 *
 * A host wires ONE `Client.layer.*` adapter and then dispatches to any actor
 * without knowing the process topology; the variant chosen at the host
 * boundary decides HOW dispatch reaches the consumer.
 *
 * Named after rivet's `Client` (see `docs/adr/0001-actor-runtime-seams.md` —
 * Rivet's API is a DX target, not its runtime). Unlike Bite's `cad5fc7` thin
 * `Client.layer` namespace (which only re-bundled the three sender Tags), this
 * is a DEEP `Context.Service` Tag (decision #1, `CONTEXT.md:21-25`): it OWNS
 * `send / peek / flush / redeliver / resolve` and pulls the wire-envelope
 * builder INSIDE the seam. Address resolution stays an INTERNAL strategy the
 * Client holds (`ActorAddressResolver`), not a public Tag.
 *
 * The four adapters differ only in which underlying transport they bundle:
 *
 * - `Client.layer.fromConfig` — STORAGE-ONLY producer / ops hosts. Dispatches
 *   through `MessageStorage` directly (no `Sharding`, no entity managers, no
 *   15s `notifyLocal` deadlock). Requires `MessageStorage` + `ShardingConfig`.
 * - `Client.layer.fromSharding` — CONSUMER hosts that already host the full
 *   cluster runtime. Dispatches through `sharding.sendOutgoing`. Requires
 *   `Sharding`. MUST bundle `Snowflake.layerGenerator` explicitly because
 *   `Sharding.layer` installs its own generator WITHOUT re-exposing the Tag and
 *   `Client.send` needs it to mint request ids.
 * - `Client.layer.memory` — self-contained (in-memory `MessageStorage` +
 *   default `ShardingConfig`) for tests and single-process setups.
 * - `Client.layer.test` — over an injected test `ActorMailbox` (built by
 *   `Actor.toTestLayer` from the entity's per-entity test rpcClient). Routes a
 *   prebuilt `OutgoingRequest` back through that client with `{ discard: true }`.
 *   SEND-ROUTING + CONTROL adapter ONLY: the injected per-entity test client is
 *   `Entity.makeTestClient` (a raw `RpcServer.makeNoSerialization` — it bypasses
 *   the `entityManager`, the ONLY component that persists handler replies to
 *   `MessageStorage`). So the handler's reply is an in-memory RPC response that
 *   `{ discard: true }` throws away — it NEVER reaches storage. `peek` therefore
 *   stays `Pending` over this adapter's bundled storage; a reply round-trip
 *   (`send → peek → Success/Failure`) is structurally impossible here and is
 *   covered instead by `fromSharding` (real cluster runtime) and the
 *   `fromWorkflow` test path (WorkflowEngine-persisted). What this adapter OWNS
 *   end-to-end: `send` routes the prebuilt request through the INJECTED mailbox,
 *   and `peek / flush / redeliver` operate over its bundled storage.
 */
import type { Schema } from "effect";
import { Context, Effect, Layer, Option } from "effect";
import {
  ClusterSchema,
  type Entity as ClusterEntity,
  type EntityAddress,
  Envelope,
  Message,
  MessageStorage,
  type Sharding,
  type ShardingConfig,
  Snowflake,
} from "effect/unstable/cluster";
import type {
  AlreadyProcessingMessage,
  EntityNotAssignedToRunner,
  MailboxFull,
  MalformedMessage,
  PersistenceError,
} from "effect/unstable/cluster/ClusterError";
import * as Headers from "effect/unstable/http/Headers";
import type { Rpc, RpcClient } from "effect/unstable/rpc";
import {
  ActorAddressResolver,
  ActorAddressResolverLayer,
  type ActorAddressResolverShape,
} from "./actor-address-resolver.js";
import {
  ActorMailbox,
  ActorMailboxLayer,
  MailboxError,
  type ActorMailboxShape,
} from "./actor-mailbox.js";
import { ActorSenderLayer } from "./actor-sender.js";
import { ActorDefect } from "./actor-defect.js";
import { type ExecId, type PeekResult, type ReplyDefs, peekStoredReply } from "./receipt.js";
import type { Invocation } from "./operation.js";
import { isOpaquePayload } from "./operation.js";

// ── Address helper ─────────────────────────────────────────────────────────
export const resolveEntityAddress = (
  resolver: ActorAddressResolverShape,
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- entity Rpcs erased
  entity: ClusterEntity.Entity<string, any>,
  actorId: string,
): EntityAddress.EntityAddress => resolver.resolveEntity(entity, actorId);

// ── OutgoingRequest builder for .send dispatch ───────────────────────────
// Produces the same OutgoingRequest shape as upstream `Sharding.makeClient`
// but bypasses Sharding entirely so the host doesn't need a registered
// entity manager. The mailbox's `send` decides what to do with the request
// (saveRequest vs. sendOutgoing).
//
// Captures fiber.currentContext into the OutgoingRequest to mirror upstream's
// `makeClient`. MessageStorage duplicate decoding reads `message.context` —
// empty context is wrong for any schema that requires services at decode time.
export const buildOutgoingRequestForSend = (
  invocation: Invocation,
  address: EntityAddress.EntityAddress,
  snowflakeGen: Snowflake.Generator["Service"],
): Effect.Effect<Message.OutgoingRequest<Rpc.Any>> =>
  Effect.gen(function* () {
    const { entity, tag, definition, operation } = invocation;
    const rpc = entity.protocol.requests.get(tag);
    if (!rpc) {
      return yield* Effect.die(
        new ActorDefect({
          message: `effect-encore: rpc "${tag}" not found on entity "${entity.type}"`,
        }),
      );
    }
    // eslint-disable-next-line typescript-eslint/no-explicit-any -- payloadSchema type-erased
    const payloadSchema = rpc.payloadSchema as Schema.Top;

    let payload: unknown;
    if (!definition.payload) {
      // Zero-payload op. compileRpc still creates an EmptyPayloadClass.
      // eslint-disable-next-line typescript-eslint/no-explicit-any -- class constructor
      payload = new (payloadSchema as any)({});
    } else if (isOpaquePayload(definition.payload)) {
      payload = operation["_payload"];
    } else {
      const { _tag: _t, ...fields } = operation;
      void _t;
      // eslint-disable-next-line typescript-eslint/no-explicit-any -- class constructor
      payload = new (payloadSchema as any)(fields);
    }

    const fiberContext = yield* Effect.context<never>();

    const envelope = Envelope.makeRequest({
      requestId: snowflakeGen.nextUnsafe(),
      address,
      tag: tag as never,
      payload: payload as never,
      headers: Headers.empty,
    });

    // Mirror upstream `Sharding.makeClient` annotation derivation
    // (`Sharding.js:702`): `rpc.annotations` is the static annotation context,
    // but the per-request `OutgoingRequest.annotations` is computed by reading
    // `ClusterSchema.Dynamic` (a transformer fn) from the static annotations
    // and applying it to the envelope. The Persisted gate at sendOutgoing reads
    // `message.annotations` for OutgoingRequest specifically — `Context.empty()`
    // here would silently route persisted requests as non-persisted.
    // eslint-disable-next-line typescript-eslint/no-explicit-any -- annotations type-erased
    const rpcAnnotations = rpc.annotations as Context.Context<never>;
    const dynamicFn = Context.get(rpcAnnotations, ClusterSchema.Dynamic);
    // eslint-disable-next-line typescript-eslint/no-explicit-any -- envelope shape erased through Dynamic
    const annotations = dynamicFn(rpcAnnotations, envelope as any);

    return new Message.OutgoingRequest({
      rpc,
      // eslint-disable-next-line typescript-eslint/no-explicit-any -- mirror of Sharding.makeClient
      context: fiberContext as any,
      envelope,
      lastReceivedReply: Option.none(),
      respond: () => Effect.void,
      annotations,
    });
  });

// Test ActorMailbox impl that routes a prebuilt OutgoingRequest back through
// the entity's per-entity test rpcClient (with `{ discard: true }`). Used by
// `Actor.toTestLayer` and `Client.layer.test`. NOT exported from the barrel —
// production hosts use the real factories.
export const makeTestMailboxImpl = (
  makeClient: (entityId: string) => Effect.Effect<RpcClient.RpcClient<Rpc.Any, never>>,
): ActorMailboxShape => ({
  send: (request) =>
    Effect.gen(function* () {
      const envelope = request.envelope;
      const entityId = envelope.address.entityId as string;
      const tag = envelope.tag;
      const payload = envelope.payload;
      const rpcClient = yield* makeClient(entityId);
      // eslint-disable-next-line typescript-eslint/no-explicit-any -- rpcClient type-erased
      const fn = (rpcClient as unknown as Record<string, Function>)[tag];
      if (!fn) {
        return yield* new MailboxError({
          cause: new ActorDefect({
            message: `effect-encore test mailbox: unknown rpc "${String(tag)}" on entity "${String(envelope.address.entityType)}"`,
          }),
        });
      }
      yield* fn(payload, { discard: true }) as Effect.Effect<void>;
    }),
});

// ── Client — the deep transport Tag ───────────────────────────────────────
//
// The error union of `Client.send` is exactly the former `OperationHandle.send`
// error union, so collapsing the public `.send` R-channel from the triad
// (`ActorMailbox | ActorAddressResolver | Snowflake.Generator`) to a single
// `Client` Tag preserves the error contract — only the requirement collapses.

export type ClientSendError =
  | MailboxError
  | PersistenceError
  | MailboxFull
  | AlreadyProcessingMessage
  | EntityNotAssignedToRunner;

/* eslint-disable typescript-eslint/no-explicit-any -- entity Rpcs are type-erased at the transport surface */
export interface ClientShape {
  /**
   * Resolve the destination address for `entityId` via the Client's internal
   * `ActorAddressResolver` strategy (decision #1: resolution is internal, not a
   * public Tag).
   */
  readonly resolve: (
    entity: ClusterEntity.Entity<string, any>,
    entityId: string,
  ) => EntityAddress.EntityAddress;
  /**
   * Build the wire envelope (pulled INSIDE the seam) and dispatch it through
   * the wired mailbox. Returns the minted `ExecId` for the dispatched op.
   *
   * The Invocation owns the payload, operation value, and derived identity.
   * Client does not repeat compilation work.
   */
  readonly send: (invocation: Invocation) => Effect.Effect<ExecId, ClientSendError>;
  /**
   * Peek the persisted reply for `execId` and classify its terminal state.
   */
  readonly peek: (
    entity: ClusterEntity.Entity<string, any>,
    execId: string,
    definitions?: ReplyDefs,
  ) => Effect.Effect<PeekResult, PersistenceError | MalformedMessage>;
  /** Clear every persisted message for the entity (`flushImpl`, moved inside). */
  readonly flush: (
    entity: ClusterEntity.Entity<string, any>,
    actorId: string,
  ) => Effect.Effect<void, PersistenceError>;
  /** Reset the entity's address for redelivery (`redeliverImpl`, moved inside). */
  readonly redeliver: (
    entity: ClusterEntity.Entity<string, any>,
    actorId: string,
  ) => Effect.Effect<void, PersistenceError>;
}
/* eslint-enable typescript-eslint/no-explicit-any */

export class Client extends Context.Service<Client, ClientShape>()("effect-encore/client") {}

/**
 * Build the deep `Client` service over the wired transport Tags. Pulls the
 * mailbox, resolver, snowflake generator, and storage from context at layer-build time,
 * so every Client METHOD has an
 * empty requirement channel — the deps are captured in the closure.
 */
const makeClientService: Effect.Effect<
  ClientShape,
  never,
  ActorMailbox | ActorAddressResolver | Snowflake.Generator | MessageStorage.MessageStorage
> = Effect.gen(function* () {
  const mailbox = yield* ActorMailbox;
  const resolver = yield* ActorAddressResolver;
  const snowflakeGen = yield* Snowflake.Generator;
  const storage = yield* MessageStorage.MessageStorage;
  const resolve: ClientShape["resolve"] = (entity, entityId) =>
    resolveEntityAddress(resolver, entity, entityId);

  return {
    resolve,
    send: (invocation) =>
      Effect.gen(function* () {
        const address = resolve(invocation.entity, invocation.identity.entityId);
        const request = yield* buildOutgoingRequestForSend(invocation, address, snowflakeGen);
        yield* mailbox.send(request);
        return invocation.identity.execId;
      }),
    peek: (entity, execId, definitions) =>
      // Both services are captured here, so the Client.peek requirement is empty.
      peekStoredReply(entity, execId, definitions).pipe(
        Effect.provideService(MessageStorage.MessageStorage, storage),
        Effect.provideService(ActorAddressResolver, resolver),
      ),
    flush: (entity, actorId) =>
      storage.clearAddress(resolveEntityAddress(resolver, entity, actorId)),
    redeliver: (entity, actorId) =>
      storage.resetAddress(resolveEntityAddress(resolver, entity, actorId)),
  };
});

// ── Adapters ──────────────────────────────────────────────────────────────

/**
 * Bare `Client` service layer over the already-wired transport Tags
 * (`ActorMailbox | ActorAddressResolver | Snowflake.Generator | MessageStorage`).
 * The four public `Client.layer.*` adapters compose this over a transport
 * bundle; `actor.ts`'s `toLayer`/`toTestLayer` compose it over their own
 * consumer/test support stacks (which already provide those Tags). NOT exported
 * from the package barrel — hosts wire a `Client.layer.*` adapter instead.
 */
export const clientServiceLayer: Layer.Layer<
  Client,
  never,
  ActorMailbox | ActorAddressResolver | Snowflake.Generator | MessageStorage.MessageStorage
> = Layer.effect(Client, makeClientService);

const clientLayer = clientServiceLayer;

/**
 * Storage-only producer / ops adapter. Builds the deep Client over the internal
 * `ActorSenderLayer.layer` bundle (mailbox.fromConfig + resolver.fromConfig +
 * Snowflake). Requires `MessageStorage` + `ShardingConfig`; never registers an
 * entity manager so producer-only dispatch can't deadlock on `notifyLocal`.
 */
const fromConfig: Layer.Layer<
  Client,
  never,
  MessageStorage.MessageStorage | ShardingConfig.ShardingConfig
> = clientLayer.pipe(Layer.provideMerge(ActorSenderLayer.layer));

/**
 * Consumer adapter for hosts that already host the full cluster runtime.
 * Dispatch routes through `sharding.sendOutgoing`; addresses resolve through
 * `sharding.getShardId`. Bundles `Snowflake.layerGenerator` EXPLICITLY: the
 * mailbox's `sendOutgoing` path doesn't use it directly, but `Client.send`
 * mints request ids with it, and `Sharding.layer` installs its OWN generator
 * internally WITHOUT re-exposing the Tag — so a consumer wiring only
 * `fromSharding` alongside `Sharding.layer` would otherwise hit
 * "Service not found: Snowflake.Generator".
 */
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

/**
 * Self-contained adapter with in-memory `MessageStorage` and default
 * `ShardingConfig` already provided. Drop-in for tests and single-process
 * setups. Composes the internal `ActorSenderLayer.layerMemory` bundle.
 */
const memory: Layer.Layer<Client> = clientLayer.pipe(
  Layer.provideMerge(ActorSenderLayer.layerMemory),
);

/**
 * Test adapter. Builds the deep Client over an INJECTED `ActorMailbox` (the
 * test mailbox `Actor.toTestLayer` constructs from the entity's per-entity test
 * rpcClient via {@link makeTestMailboxImpl}, routing each prebuilt
 * `OutgoingRequest` back through that client with `{ discard: true }`). The
 * resolver is pure-data `fromConfig` and the generator/storage are supplied
 * locally, so the only outstanding requirement is the injected `ActorMailbox`
 * plus `ShardingConfig`.
 *
 * CONTRACT (narrowed): send-routing + control/peek-over-its-own-storage. This
 * adapter does NOT support a `send → peek → Success/Failure` reply round-trip,
 * because the injected per-entity test client (`Entity.makeTestClient`) routes
 * replies through an in-memory `RpcServer.makeNoSerialization` that bypasses the
 * `entityManager` — the ONLY component that persists handler replies to
 * `MessageStorage`. The `{ discard: true }` consumer then throws the reply away,
 * so it reaches no storage and `peek` cannot observe it. Bundling the adapter's
 * storage vs. sharing it with the mailbox is therefore irrelevant: nothing ever
 * writes a reply to storage on this transport. Reply round-trips are covered by
 * `fromSharding` (real cluster runtime) and the `fromWorkflow` test path.
 */
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

/**
 * Layer adapters for the deep `Client` transport Tag, exposed as a namespace
 * alongside the Tag (mirrors `ActorMailboxLayer` / `ActorAddressResolverLayer`).
 */
export const layer = {
  fromConfig,
  fromSharding,
  memory,
  test,
} as const;
