import {
  AppendInput,
  AppendRecord,
  RangeNotSatisfiableError,
  S2,
  SeqNumMismatchError,
  type S2Stream,
} from "@s2-dev/streamstore";
import { Data, Effect, Ref } from "effect";
import type { S2WorkflowEngineConfig } from "./config.js";
import {
  decodeRecord,
  encodeRecord,
  type ExecutionRecord,
  type SequencedRecord,
} from "./records.js";

export class S2WorkflowEngineError extends Data.TaggedError(
  "effect-encore/s2-workflow/stream/S2WorkflowEngineError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export const isSeqNumMismatch = (error: S2WorkflowEngineError): boolean =>
  error.cause instanceof SeqNumMismatchError;

const toError = (operation: string) => (cause: unknown) =>
  new S2WorkflowEngineError({ operation, cause });

const s2Effect = <A>(
  operation: string,
  f: () => Promise<A>,
): Effect.Effect<A, S2WorkflowEngineError> =>
  Effect.tryPromise({
    try: f,
    catch: toError(operation),
  });

export interface ExecutionRead {
  readonly tailSeqNum: number;
  readonly records: ReadonlyArray<SequencedRecord>;
}

export interface S2WorkflowStreams {
  readonly ensure: (name: string) => Effect.Effect<void, S2WorkflowEngineError>;
  readonly read: (name: string) => Effect.Effect<ExecutionRead, S2WorkflowEngineError>;
  readonly append: (
    name: string,
    records: ReadonlyArray<ExecutionRecord>,
    options?: { readonly matchSeqNum?: number },
  ) => Effect.Effect<void, S2WorkflowEngineError>;
}

export const makeStreams = (config: S2WorkflowEngineConfig): Effect.Effect<S2WorkflowStreams> =>
  Effect.gen(function* () {
    const ensured = yield* Ref.make<ReadonlySet<string>>(new Set());
    const s2 = new S2({
      accessToken: config.accessToken,
      endpoints: config.endpoints,
      requestTimeoutMillis: config.requestTimeoutMillis,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
      retry: {
        maxAttempts: 3,
        appendRetryPolicy: "noSideEffects",
      },
    });
    const basin = s2.basin(config.basin);
    const stream = (name: string): S2Stream =>
      basin.stream(name, { forceTransport: config.forceTransport });

    const ensure = (name: string): Effect.Effect<void, S2WorkflowEngineError> =>
      Ref.get(ensured).pipe(
        Effect.flatMap((set) => {
          if (set.has(name)) return Effect.void;
          return s2Effect("ensureStream", () => basin.streams.ensure({ stream: name })).pipe(
            Effect.andThen(
              Ref.update(ensured, (current) => {
                const next = new Set(current);
                next.add(name);
                return next;
              }),
            ),
          );
        }),
      );

    const readPage = (
      name: string,
      nextSeqNum: number,
      accumulated: ReadonlyArray<SequencedRecord>,
    ): Effect.Effect<ExecutionRead, S2WorkflowEngineError> =>
      s2Effect("readExecution", () =>
        stream(name).read(
          {
            start: { from: { seqNum: nextSeqNum }, clamp: true },
            stop: { limits: { count: 1000 } },
            ignoreCommandRecords: true,
          },
          { as: "string" },
        ),
      ).pipe(
        Effect.flatMap((batch) =>
          Effect.forEach(batch.records, (record) =>
            decodeRecord(record.body).pipe(
              Effect.map(
                (decoded): SequencedRecord => ({ seqNum: record.seqNum, record: decoded }),
              ),
              Effect.mapError(toError("decodeExecutionRecord")),
            ),
          ).pipe(
            Effect.flatMap((decoded) => {
              const records = [...accumulated, ...decoded];
              const last = batch.records[batch.records.length - 1];
              const nextAfterLast = last === undefined ? nextSeqNum : last.seqNum + 1;
              const tailSeqNum = Math.max(batch.tail?.seqNum ?? nextSeqNum, nextAfterLast);
              if (
                last === undefined ||
                batch.records.length < 1000 ||
                last.seqNum + 1 >= tailSeqNum
              ) {
                return Effect.succeed({ tailSeqNum, records });
              }
              return readPage(name, last.seqNum + 1, records);
            }),
          ),
        ),
        Effect.catch((error) =>
          error.cause instanceof RangeNotSatisfiableError && error.cause.tail?.seq_num === 0
            ? Effect.succeed({ tailSeqNum: 0, records: accumulated })
            : Effect.fail(error),
        ),
      );

    const read = (name: string): Effect.Effect<ExecutionRead, S2WorkflowEngineError> =>
      ensure(name).pipe(Effect.andThen(readPage(name, 0, [])));

    const append = (
      name: string,
      records: ReadonlyArray<ExecutionRecord>,
      options?: { readonly matchSeqNum?: number },
    ): Effect.Effect<void, S2WorkflowEngineError> =>
      Effect.gen(function* () {
        yield* ensure(name);
        const bodies = yield* Effect.forEach(records, (record) =>
          encodeRecord(record).pipe(Effect.mapError(toError("encodeExecutionRecord"))),
        );
        yield* s2Effect("appendExecution", () =>
          stream(name).append(
            AppendInput.create(
              bodies.map((body) => AppendRecord.string({ body })),
              options,
            ),
          ),
        );
      });

    return { ensure, read, append } satisfies S2WorkflowStreams;
  });
