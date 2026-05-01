export type DedupeStrategy = "atMostOnce" | "inProgress";

const IN_PROGRESS_PREFIX = "effect-encore:dedupe:in-progress:";

export const DedupeStrategy = {
  AtMostOnce: "atMostOnce" as const,
  InProgress: "inProgress" as const,
  default: "atMostOnce" as const,

  encodePrimaryKey(strategy: DedupeStrategy | undefined, primaryKey: string): string {
    if (strategy !== "inProgress") {
      return primaryKey;
    }
    return `${IN_PROGRESS_PREFIX}${primaryKey}`;
  },

  fromPrimaryKey(primaryKey: string): DedupeStrategy {
    return primaryKey.includes(IN_PROGRESS_PREFIX) ? "inProgress" : "atMostOnce";
  },

  stripPrimaryKey(primaryKey: string): string {
    return primaryKey.replace(IN_PROGRESS_PREFIX, "");
  },
};
