// encore-ds/fluent — firegrid-shaped durable authoring over @effect/workflow.
// Slice 1: `service` + free `run` / `all` / `race`, registered via
// `serviceLayer` and invoked through `client`.

export {
  run,
  all,
  race,
  select,
  spawn,
  type RunOptions,
  type RunAction,
  type SelectResult,
  type FluentRequirements,
} from "./free.ts";
export {
  service,
  schemas,
  type ServiceDefinition,
  type ServiceConfig,
  type HandlerDescriptor,
  type InvokeOptions,
  type Handlers,
  type HandlerInput,
  type HandlerOutput,
} from "./service.ts";
export {
  serviceLayer,
  makeRuntime,
  client,
  sendClient,
  type Ingress,
  type CallClient,
  type BoundClient,
  type SendClient,
} from "./runtime.ts";

// Engine layer re-exported for convenience — provide alongside serviceLayer.
export { workflowEngineLayer } from "../workflow.ts";
