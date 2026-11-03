import { MessageStorage, ShardingConfig, Snowflake } from "effect/cluster";
import { Layer } from "effect";
import { type ActorAddressResolver, ActorAddressResolverLayer } from "./actor-address-resolver.js";
import { type ActorMailbox, ActorMailboxLayer } from "./actor-mailbox.js";

const layer: Layer.Layer<
  ActorMailbox | ActorAddressResolver | Snowflake.Generator,
  never,
  MessageStorage.MessageStorage | ShardingConfig.ShardingConfig
> = Layer.mergeAll(
  ActorMailboxLayer.fromConfig,
  ActorAddressResolverLayer.fromConfig,
  Snowflake.layerGenerator,
);

const layerMemory: Layer.Layer<
  | ActorMailbox
  | ActorAddressResolver
  | Snowflake.Generator
  | MessageStorage.MessageStorage
  | MessageStorage.MemoryDriver
> = layer.pipe(
  Layer.provideMerge(MessageStorage.layerMemory),
  Layer.provideMerge(ShardingConfig.layer()),
);

export const ActorSenderLayer = {
  layer,
  layerMemory,
};
