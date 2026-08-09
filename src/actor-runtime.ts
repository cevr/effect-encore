/** Internal Layer assembly for one actor runtime. */
import { Layer } from "effect";

/**
 * Build a service once for this support stack and expose both outputs.
 * `Layer.fresh` prevents one actor from reusing another actor's captured transport.
 */
export const attachFreshService = <Support, Service, E, R, ServiceR>(
  support: Layer.Layer<Support, E, R>,
  service: Layer.Layer<Service, never, ServiceR>,
): Layer.Layer<Support | Service, E, R | Exclude<ServiceR, Support>> =>
  Layer.merge(support, Layer.provide(Layer.fresh(service), support));

/**
 * Expose the runtime base and close state and control clients over that base.
 * The returned methods do not leak runtime assembly services to callers.
 */
export const assembleActorRuntime = <Base, State, Control, E, R, StateR, ControlR>(
  base: Layer.Layer<Base, E, R>,
  state: Layer.Layer<State, never, StateR>,
  control: Layer.Layer<Control, never, ControlR>,
): Layer.Layer<Base | State | Control, E, R | Exclude<StateR, Base> | Exclude<ControlR, Base>> =>
  Layer.mergeAll(base, Layer.provide(state, base), Layer.provide(control, base));
