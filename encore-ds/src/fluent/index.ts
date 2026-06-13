// encore-ds/fluent — firegrid-shaped durable authoring over @effect/workflow.
// Slice 1: `service` + free `run` / `all` / `race`, registered via
// `serviceLayer` and invoked through `client`.

export { run, all, race, type RunOptions, type RunAction, type FluentRequirements } from "./free.ts";
export {
  service,
  type ServiceDefinition,
  type ServiceConfig,
  type Handlers,
  type HandlerInput,
  type HandlerOutput,
} from "./service.ts";
export { serviceLayer, client, type CallClient } from "./runtime.ts";

// Engine layer re-exported for convenience — provide alongside serviceLayer.
export { workflowEngineLayer } from "../workflow.ts";
