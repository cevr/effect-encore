# ADR-0002 — Deep Encore interfaces over Effect primitives

- **Status:** accepted
- **Date:** 2026-08-09
- **Supersedes:** ADR-0001

## Context

Effect supplies the runtime primitives. Encore must supply a small application API.
Callers must not assemble transport, reply, synchronization, or deletion strategies.

The earlier design exposed strategy Tags. It also repeated operation compilation.
This made the caller and the runtime think about the same assembly.

## Decision

Encore provides deep interfaces over Effect primitives.

1. `WorkflowStepContext` keeps the convenient Step API.
   Its race operation delegates to Effect `Activity.raceAll`.
2. One `Invocation` owns the input, operation value, identity, and ExecId.
   Execute and send compile it once.
3. `Client` owns transport and stored reply lookup.
   Mailbox, address resolver, and reply lookup stay internal.
4. One actor runtime assembler owns Layer lifetime and composition.
5. `State<A>` is opaque.
   Module functions own reads, writes, changes, and synchronization.
6. Effect owns `MessageStorage`.
   Encore owns only invocation and address deletion for rerun.

## Consequences

- Callers wire `ClientLayer` or an actor Layer.
- Callers do not wire mailbox, resolver, or reply-source Tags.
- `State<A>` does not expose its closures, PubSub, or semaphore.
- SQL and custom storage factories remain public.
- The internal deletion Tag is not part of the package root.
- The ExecId byte format does not change.
