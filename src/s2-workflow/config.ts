import type { S2ClientOptions, S2EndpointsInit, SessionTransports } from "@s2-dev/streamstore";

export interface S2WorkflowEngineConfig {
  readonly basin: string;
  readonly accessToken: string;
  readonly endpoints?: S2EndpointsInit | S2ClientOptions["endpoints"];
  readonly streamPrefix?: string;
  readonly runnerId: string;
  readonly forceTransport?: SessionTransports;
  readonly requestTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
  readonly ownerTtlMillis?: number;
  readonly snapshotEveryRecords?: number;
}

export const defaultOwnerTtlMillis = 30_000;
