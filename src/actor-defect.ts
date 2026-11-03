import { Data } from "effect";

export class ActorDefect extends Data.TaggedError("effect-encore/actor-defect/ActorDefect")<{
  readonly message: string;
}> {}
