import { Schema } from "effect";

// effect-durable-operators.PACKAGE.3: errors are Schema.TaggedError so they
// remain serializable and matchable across durable boundaries.

export class DurableTableError extends Schema.TaggedErrorClass<DurableTableError>()(
  "DurableTableError",
  {
    table: Schema.String,
    cause: Schema.Defect,
  },
) {}
