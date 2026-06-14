import type { S2WorkflowEngineConfig } from "./config.js";

export const normalizePrefix = (prefix: S2WorkflowEngineConfig["streamPrefix"]): string => {
  const raw = prefix ?? "encore";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
};

export const segment = (value: string): string => encodeURIComponent(value).replaceAll("%", "~");

export const unsegment = (value: string): string => decodeURIComponent(value.replaceAll("~", "%"));

export const workflowExecutionStream = (
  prefix: string,
  workflowName: string,
  executionId: string,
): string => `${prefix}/workflows/${segment(workflowName)}/${segment(executionId)}`;

export const workflowPrefix = (prefix: string): string => `${prefix}/workflows/`;
