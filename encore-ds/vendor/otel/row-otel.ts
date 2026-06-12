// firegrid-row-otel-propagation.ROW_OTEL.1
// firegrid-row-otel-propagation.ROW_OTEL.2
//
// W3C-traceparent-on-row carrier (Item A of the §6 trace-graph upgrade).
//
// Design constraints (Effect-native primitives only):
//   - producers MUST NOT thread `_otel` through every row constructor — one
//     spread helper at the append site stamps a row in a single line.
//   - consumers MUST NOT touch every `withSpan` call's `parent:` field — one
//     pipe-friendly operator sets the parent on whatever effect runs the row
//     pickup, using `Effect.withParentSpan` (the parent then propagates to
//     all descendant `withSpan` calls automatically).
//   - both sides use only the in-tree Effect tracer primitives — no custom
//     SpanProcessor, no `propagation.extract/inject`, no Context.Tag for
//     trace state. `@effect/opentelemetry`'s `OtelSpan` honors `effectParent`
//     directly (repos/effect/packages/opentelemetry/src/internal/tracer.ts:65),
//     so the OTLP exporter renders cross-process parents with ZERO exporter
//     changes.
//
// The wire shape is the 1-line W3C `traceparent` string per the W3C Trace
// Context spec; the in-memory shapes are `Tracer.Span` (producer) and
// `Tracer.ExternalSpan` (consumer).
//
// `_otel` is OPTIONAL on every row schema that embeds it. Missing means
// "legacy/external producer with no captured trace context" — the consumer
// starts a new root span, NEVER an error.

import { Effect, Option, Schema } from "effect"
import * as Tracer from "effect/Tracer"

/**
 * Optional W3C trace context carried on durable rows.
 *
 * - `traceparent` follows the W3C format `00-<32hex traceId>-<16hex spanId>-<2hex flags>`.
 * - `tracestate` is reserved for vendor state; unused today but accepted so
 *   downstream propagation does not need a schema bump.
 */
export const RowOtelContextSchema = Schema.Struct({
  traceparent: Schema.String,
  tracestate: Schema.optional(Schema.String),
}).annotate({
  identifier: "firegrid.row.otelContext",
  title: "W3C trace context carried on a durable row",
  description:
    "Optional W3C traceparent/tracestate captured at row-append time. Absent on legacy/external rows; consumers start a new root span when missing.",
})
export type RowOtelContext = Schema.Schema.Type<typeof RowOtelContextSchema>

/** Internal — W3C traceparent: `00-<32hex traceId>-<16hex spanId>-<2hex flags>`. */
const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/

const flagsFor = (sampled: boolean): string => (sampled ? "01" : "00")

const encodeTraceparent = (parent: {
  readonly traceId: string
  readonly spanId: string
  readonly sampled: boolean
}): string => `00-${parent.traceId}-${parent.spanId}-${flagsFor(parent.sampled)}`

const sampledFromFlags = (flags: string): boolean =>
  (Number.parseInt(flags, 16) & 0x01) === 0x01

/**
 * Parse a W3C `traceparent` string. Malformed input ⇒ `Option.none()` — the
 * consumer treats that as "no parent" (new root), never an error.
 */
export const parseTraceparent = (
  traceparent: string,
): Option.Option<{
  readonly traceId: string
  readonly spanId: string
  readonly sampled: boolean
}> => {
  if (!TRACEPARENT_PATTERN.test(traceparent)) {
    return Option.none()
  }
  const [, traceId, spanId, flags] = traceparent.split("-") as [
    string,
    string,
    string,
    string,
  ]
  return Option.some({ traceId, spanId, sampled: sampledFromFlags(flags) })
}

/**
 * Build an `ExternalSpan` from a row that may carry `_otel`. Returns
 * `undefined` for missing/malformed — the consumer treats that as "no parent".
 *
 * Accepts both well-typed `{ _otel?: RowOtelContext }` rows and arbitrary
 * `unknown` (the wait router's source row is unknown until decoded).
 */
export const rowOtelExternalSpan = (
  row: unknown,
): Tracer.ExternalSpan | undefined => {
  if (row === null || typeof row !== "object") return undefined
  const otel = (row as { _otel?: unknown })._otel
  if (otel === null || typeof otel !== "object") return undefined
  const traceparent = (otel as { traceparent?: unknown }).traceparent
  if (typeof traceparent !== "string") return undefined
  return Option.match(parseTraceparent(traceparent), {
    onNone: () => undefined,
    onSome: (parsed) =>
      Tracer.externalSpan({
        traceId: parsed.traceId,
        spanId: parsed.spanId,
        sampled: parsed.sampled,
      }),
  })
}

/**
 * PRODUCER one-liner. Stamp `_otel` onto a row from the current Effect span.
 *
 * Captures `Effect.currentSpan` INSIDE the call (so wrapping the append in
 * `Effect.withSpan(..., { kind: "producer" })` makes the producer span the
 * parent of all downstream consumer spans). If no span is active, returns the
 * row unchanged — the producer NEVER fabricates trace identity.
 *
 * ```ts
 * const stamped = yield* stampRowOtel(makeRuntimeInputIntentRow(request))
 * yield* table.insertOrGet(stamped)
 * ```
 */
export const stampRowOtel = <R extends object>(
  row: R,
): Effect.Effect<R & { readonly _otel?: RowOtelContext }> =>
  Effect.currentSpan.pipe(
    Effect.map((span): R & { readonly _otel?: RowOtelContext } => ({
      ...row,
      _otel: {
        traceparent: encodeTraceparent({
          traceId: span.traceId,
          spanId: span.spanId,
          sampled: span.sampled,
        }),
      },
    })),
    Effect.orElseSucceed(() => row as R & { readonly _otel?: RowOtelContext }),
  )

/**
 * CONSUMER one-liner. If `row` carries a parseable `_otel`, set its parent
 * span as the parent for ALL spans created downstream (via
 * `Effect.withParentSpan`). If missing/malformed, the effect is unchanged —
 * a new root is the natural fallback.
 *
 * `Effect.withParentSpan` covers every descendant `Effect.withSpan` in scope,
 * so individual span call-sites do NOT need a per-span `parent:` field.
 *
 * ```ts
 * reconcileContextRequest(request, opts).pipe(
 *   withRowOtelParent(request),
 *   Effect.withSpan("firegrid.host.control_request.context.reconcile", { kind: "consumer", ... }),
 * )
 * ```
 */
export const withRowOtelParent = (
  row: unknown,
) =>
<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>> => {
  const parent = rowOtelExternalSpan(row)
  return parent === undefined
    ? (effect as Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>>)
    : Effect.withParentSpan(effect, parent)
}
