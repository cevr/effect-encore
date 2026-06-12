import type { Activity } from "effect/unstable/workflow"
import { Effect } from "effect"

/**
 * Contract-coverage seam annotations for runtime-owned `Activity.make` spans.
 *
 * The span named after an Activity (`activity.name`) is created inside vendored
 * `@effect/workflow` `Activity.make` -> `makeExecute`
 * (`repos/effect/packages/workflow/src/Activity.ts`), which wraps the activity
 * body in `Effect.withSpan(effect, activity.name, …)` with no call-site hook for
 * attributes. So a runtime call site cannot attach
 * `firegrid.seam.kind` / `firegrid.contract.id` to that span the normal way
 * (the tf-mmh2 finding).
 *
 * This module is the smallest fully-local hook that closes that gap WITHOUT
 * editing `repos/effect`:
 *
 *  1. `withActivityContract` stashes the seam classification on the Activity
 *     object itself (a non-enumerable Symbol property on the very object that
 *     `makeExecute` closes over and later hands to the engine).
 *  2. `annotateActivityContractSpan` is run by the runtime-owned engine
 *     (`engine-runtime.ts` `activityExecute`) at its entry — i.e. BEFORE the
 *     engine opens its own `firegrid.workflow_engine.activity.execute` span, so
 *     the current span is still the Activity-name span created by `makeExecute`.
 *     `Effect.annotateCurrentSpan` therefore lands the attributes on the
 *     Activity-name span. (Verified: `makeExecute` -> `wrapActivityResult`
 *     [contextWithEffect/onExit, no span] -> `WorkflowEngine` `fnUntraced`
 *     wrapper [no span] -> our `activityExecute`. Our method is the only caller
 *     path, always invoked inside the name span.)
 *
 * Result: runtime-owned activity-name span families carry a resolving
 * `firegrid.contract.id` in regenerated traces, so contract-coverage (`C`)
 * counts them — see `docs/architecture/runtime-shrink-loop.md`.
 */

/** Seam classification vocabulary (runtime-dynamics-map.md §4). Internal: call
 *  sites pass a string literal to {@link withActivityContract}. */
type FiregridSeamKind =
  | "transform"
  | "authority"
  | "durability"
  | "process"
  | "concurrency"
  | "ordering"
  | "bridge_debt"
  | "relay"

interface ActivityContract {
  readonly seamKind: FiregridSeamKind
  /**
   * A resolving `firegrid.contract.id`: an ACID token (declared in a
   * `*.feature.yaml`) or an existing repo path to the governing
   * ACID/SDD/decision doc. Unresolved ids (incl. `"TODO"`) fail the gate.
   */
  readonly contractId: string
}

const ContractAttributes = Symbol.for("firegrid/contract-activity/attributes")

interface ContractCarrier {
  [ContractAttributes]?: Readonly<Record<string, string>>
}

/**
 * Attach a seam contract to a runtime-owned Activity so the engine can annotate
 * its (vendored) `activity.name` span. Mutates and returns the SAME activity
 * object, because `Activity.make` closes over the returned object and hands that
 * exact reference to the engine; a spread copy would not be seen.
 */
export const withActivityContract = <A extends Activity.Any>(
  activity: A,
  contract: ActivityContract,
): A => {
  ;(activity as A & ContractCarrier)[ContractAttributes] = {
    "firegrid.seam.kind": contract.seamKind,
    "firegrid.contract.id": contract.contractId,
  }
  return activity
}

/** The contract attributes attached via {@link withActivityContract}, if any. */
const activityContractAttributes = (
  activity: Activity.Any,
): Readonly<Record<string, string>> | undefined =>
  (activity as Activity.Any & ContractCarrier)[ContractAttributes]

/**
 * Annotate the CURRENT span with the activity's seam contract, if one was
 * attached. Must be run at the engine's `activityExecute` entry, before the
 * engine opens its own span, so the current span is the `activity.name` span.
 * A no-op for unannotated activities.
 */
export const annotateActivityContractSpan = (
  activity: Activity.Any,
): Effect.Effect<void> => {
  const attributes = activityContractAttributes(activity)
  return attributes === undefined
    ? Effect.void
    : Effect.annotateCurrentSpan(attributes)
}
