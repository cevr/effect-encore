import { Data } from "effect";
import type { Offset } from "./DurableStream.ts";

export class DecodeError extends Data.TaggedError("DurableStream/DecodeError")<{
  readonly cause: unknown;
  readonly raw: unknown;
}> {}

export class TransportError extends Data.TaggedError("DurableStream/TransportError")<{
  readonly cause: unknown;
}> {}

export class NotFound extends Data.TaggedError("DurableStream/NotFound")<{
  readonly url: string;
}> {}

export class Conflict extends Data.TaggedError("DurableStream/Conflict")<{
  readonly reason: string;
}> {}

export class Gone extends Data.TaggedError("DurableStream/Gone")<{
  readonly url: string;
}> {}

export class StreamClosed extends Data.TaggedError("DurableStream/StreamClosed")<{
  readonly finalOffset: Offset;
}> {}

export class StaleEpoch extends Data.TaggedError("DurableStream/StaleEpoch")<{
  readonly currentEpoch: number;
}> {}

export class SequenceGap extends Data.TaggedError("DurableStream/SequenceGap")<{
  readonly expectedSeq: number;
  readonly receivedSeq: number;
}> {}

export type ReadError = DecodeError | TransportError | NotFound | Gone;
export type WriteError = TransportError | StreamClosed | Conflict | NotFound | Gone;
export type ProducerError = StaleEpoch | SequenceGap | TransportError;
