import { Context } from "effect";

/**
 * Runtime configuration for an encore-ds process: the Durable Streams server
 * base URL (and optional auth headers). Every actor's physical stream URL is
 * derived from this base + the actor address — see `addressing.ts`, the one
 * seam that knows the physical layout.
 */
export interface EncoreConfigShape {
  /** Base URL of the Durable Streams server, e.g. "http://127.0.0.1:8787". */
  readonly baseUrl: string;
  /** Optional per-request headers (auth, tenant) passed to every stream. */
  readonly headers?: Readonly<Record<string, string>>;
}

export class EncoreConfig extends Context.Service<EncoreConfig, EncoreConfigShape>()(
  "encore-ds/EncoreConfig",
) {}
