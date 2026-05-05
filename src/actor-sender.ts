/**
 * ActorSender — bundle for hosts that send messages without hosting actors.
 *
 * Sender-only hosts always need the same three Tags: `ActorMailbox` to
 * enqueue, `ActorAddressResolver` to compute the destination shard, and
 * `Snowflake.Generator` to mint request IDs. Wiring them by hand every time
 * is boilerplate that hides the actual choice points (storage + config).
 *
 * `ActorSenderLayer.layer` bundles all three on the `fromConfig` variants —
 * still requires the caller to provide `MessageStorage` + `ShardingConfig`
 * so the dependency graph stays explicit at the host boundary.
 *
 * `ActorSenderLayer.layerMemory` is the trivial-case bundle: in-memory
 * storage + default sharding config + the three Tags. Use it in tests and
 * single-process toy setups where there's no shared storage to coordinate
 * with a separate consumer.
 *
 * Advanced hosts (e.g. ops-only, no `.send`) keep using the underlying
 * `ActorMailboxLayer` / `ActorAddressResolverLayer` factories directly.
 */
import { MessageStorage, ShardingConfig, Snowflake } from "effect/unstable/cluster";
import { Layer } from "effect";
import { type ActorAddressResolver, ActorAddressResolverLayer } from "./actor-address-resolver.js";
import { type ActorMailbox, ActorMailboxLayer } from "./actor-mailbox.js";

/**
 * Sender bundle (no providers). Requires
 * `MessageStorage | ShardingConfig`.
 *
 * @example
 * ```ts
 * import { Layer } from "effect";
 * import { MessageStorage, ShardingConfig } from "effect/unstable/cluster";
 * import { ActorSenderLayer } from "effect-encore";
 *
 * const SenderSupport = ActorSenderLayer.layer.pipe(
 *   Layer.provide(MessageStorage.layerMemory),
 *   Layer.provide(ShardingConfig.layer()),
 * );
 * ```
 */
const layer: Layer.Layer<
  ActorMailbox | ActorAddressResolver | Snowflake.Generator,
  never,
  MessageStorage.MessageStorage | ShardingConfig.ShardingConfig
> = Layer.mergeAll(
  ActorMailboxLayer.fromConfig,
  ActorAddressResolverLayer.fromConfig,
  Snowflake.layerGenerator,
);

/**
 * Sender bundle with in-memory `MessageStorage` and default
 * `ShardingConfig` already provided. Self-contained — drop-in for tests
 * and single-process setups.
 */
const layerMemory: Layer.Layer<
  ActorMailbox | ActorAddressResolver | Snowflake.Generator | MessageStorage.MemoryDriver
> = layer.pipe(
  Layer.provideMerge(MessageStorage.layerMemory),
  Layer.provideMerge(ShardingConfig.layer()),
);

export const ActorSenderLayer = {
  layer,
  layerMemory,
} as const;
