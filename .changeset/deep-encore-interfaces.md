---
"effect-encore": minor
---

Deepen the public API over Effect primitives.

- Keep the convenient Step API and delegate race execution to Effect Activity.
- Compile each actor invocation once before execute or send.
- Internalize mailbox, address resolver, reply-source, and storage Tags.
- Make State opaque and keep mutation mechanics inside the State module.
- Keep SQL and custom storage adapters for rerun deletion.

This release removes the public ReplySource, ActorMailbox, ActorAddressResolver,
EncoreMessageStorage, ClientShape, and State mechanic fields.
