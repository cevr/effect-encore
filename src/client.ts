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
 */
import { Context, Effect, Layer, Option, Schema } from "effect";
import type { DateTime } from "effect";
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
import {
  ExecIdCodec,
  type ExecId,
  type PeekResult,
  type ReplyDefs,
  ReplySource,
  defaultReplySource,
} from "./receipt.js";

// ── Operation shape + id helpers (transport-level, shared with actor.ts) ───
//
// These live here, NOT in actor.ts, so the runtime dependency is strictly
// one-directional (`actor.ts` → `client.ts`). The wire-envelope builder and
// the test-mailbox routing both need `isOpaquePayload`, and the OperationDef
// shape is the transport contract, so it is natural for them to live alongside
// the `Client` seam. `actor.ts` imports them back as runtime values.

/**
 * Result of an entity operation's `id` fn. Either:
 * - `string` — entityId AND primaryKey use this value (the common case).
 * - `{entityId, primaryKey?}` — divergent case where the dedup key differs
 *   from the mailbox address. primaryKey defaults to entityId when omitted.
 */
export type EntityIdReturn = string | { readonly entityId: string; readonly primaryKey?: string };

export interface OperationDef {
  readonly payload?: Schema.Top | Schema.Struct.Fields;
  readonly success?: Schema.Top;
  readonly error?: Schema.Top;
  readonly persisted?: boolean;
  readonly id: (payload: never) => EntityIdReturn;
  readonly deliverAt?: (payload: never) => DateTime.DateTime;
}

export type OperationDefs = Record<string, OperationDef>;

// Schema.Class has `fields`; scalars like Schema.String don't.
export const isOpaquePayload = (payload: unknown): boolean =>
  Schema.isSchema(payload) && !("fields" in (payload as object));

/**
 * Invoke `def.id(payload)` and normalize to `{entityId, primaryKey}`. String
 * returns map entityId === primaryKey; object returns may diverge, with
 * primaryKey defaulting to entityId.
 */
export const resolveId = (
  def: OperationDef | undefined,
  payload: unknown,
  fallbackTag: string,
): { readonly entityId: string; readonly primaryKey: string } => {
  const idFn = def?.["id"] as ((p: unknown) => EntityIdReturn) | undefined;
  if (!idFn) {
    return { entityId: fallbackTag, primaryKey: fallbackTag };
  }
  const result = idFn(payload as never);
  if (typeof result === "string") {
    return { entityId: result, primaryKey: result };
  }
  return { entityId: result.entityId, primaryKey: result.primaryKey ?? result.entityId };
};

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
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- entity Rpcs erased
  entity: ClusterEntity.Entity<string, any>,
  tag: string,
  def: OperationDef | undefined,
  address: EntityAddress.EntityAddress,
  opValue: { readonly _tag: string; readonly [key: string]: unknown },
  snowflakeGen: Snowflake.Generator["Service"],
): Effect.Effect<Message.OutgoingRequest<Rpc.Any>> =>
  Effect.gen(function* () {
    const rpc = entity.protocol.requests.get(tag);
    if (!rpc) {
      throw new Error(`effect-encore: rpc "${tag}" not found on entity "${entity.type}"`);
    }
    // eslint-disable-next-line typescript-eslint/no-explicit-any -- payloadSchema type-erased
    const payloadSchema = rpc.payloadSchema as Schema.Top;

    let payload: unknown;
    if (!def?.payload) {
      // Zero-payload op. compileRpc still creates an EmptyPayloadClass.
      // eslint-disable-next-line typescript-eslint/no-explicit-any -- class constructor
      payload = new (payloadSchema as any)({});
    } else if (isOpaquePayload(def.payload)) {
      payload = opValue["_payload"];
    } else {
      const { _tag: _t, ...fields } = opValue;
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
          cause: new Error(
            `effect-encore test mailbox: unknown rpc "${String(tag)}" on entity "${String(envelope.address.entityType)}"`,
          ),
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
  | AlreadyProcessingMessage;

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
   * `idPayload` is the ORIGINAL id-input payload as the caller supplied it. When
   * present, the minted ExecId is derived from it directly (via `def.id`) so
   * `send` agrees with `OperationHandle.executionId`/`peek`, which derive from
   * the same value. This matters for `Schema.Class` payloads: `opValue` carries
   * a struct-spread reconstruction that loses class prototype/method/`instanceof`
   * semantics, so re-running `def.id` on it can diverge. When `idPayload` is
   * omitted (e.g. direct `Client.send` callers that only hold the op value), the
   * id is recovered from `opValue` as before.
   */
  readonly send: (
    entity: ClusterEntity.Entity<string, any>,
    tag: string,
    def: OperationDef | undefined,
    opValue: { readonly _tag: string; readonly [key: string]: unknown },
    idPayload?: unknown,
  ) => Effect.Effect<ExecId, ClientSendError>;
  /**
   * Peek the persisted reply for `execId`. Composes the `ReplySource` seam —
   * the Client does NOT re-implement Exit-walking.
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
 * mailbox, resolver, snowflake generator, storage, and (optionally) the
 * `ReplySource` from context at layer-build time, so every Client METHOD has an
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
  // The reply source is resolved optionally so the default storage-backed
  // adapter is used unless a host swaps it wholesale (mirrors `peekImpl`).
  const replySource = yield* Effect.serviceOption(ReplySource).pipe(
    Effect.map(Option.getOrElse(() => defaultReplySource)),
  );

  const resolve: ClientShape["resolve"] = (entity, entityId) =>
    resolveEntityAddress(resolver, entity, entityId);

  return {
    resolve,
    send: (entity, tag, def, opValue, idPayload) =>
      Effect.gen(function* () {
        // Prefer the original id-input payload when the caller supplied it: the
        // ExecId must agree with `OperationHandle.executionId`/`peek`, which
        // derive from this same value via `def.id`. For `Schema.Class` payloads
        // the `opValue` reconstruction below loses prototype/method/`instanceof`
        // semantics, so re-deriving from it can mint a divergent ExecId.
        //
        // When `idPayload` is omitted (direct `Client.send` callers that only
        // hold the op value), recover the raw id-input from the built op value:
        // opaque/scalar payloads carry the value under `_payload`, struct
        // payloads spread their fields alongside `_tag` (the id fn reads named
        // fields off the object; the extra `_tag` key is harmless). Mirrors the
        // `pkInput` derivation in `buildActorRef.send`.
        const idInput =
          idPayload !== undefined
            ? idPayload
            : def?.payload !== undefined && isOpaquePayload(def.payload)
              ? opValue["_payload"]
              : opValue;
        const { entityId, primaryKey } = resolveId(def, idInput, tag);
        const address = resolve(entity, entityId);
        const request = yield* buildOutgoingRequestForSend(
          entity,
          tag,
          def,
          address,
          opValue,
          snowflakeGen,
        );
        yield* mailbox.send(request);
        return ExecIdCodec.encode({ entityId, tag, primaryKey });
      }),
    peek: (entity, execId, definitions) =>
      // The default adapter's R-channel is `MessageStorage | ActorAddressResolver`;
      // both are captured here, so the Client.peek requirement is empty.
      replySource
        .peek(entity, execId, definitions)
        .pipe(
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
