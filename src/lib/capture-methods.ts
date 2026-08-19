import type { Json } from "@/integrations/supabase/types";

export type CaptureMethod = "bulk" | "guided";

export type CaptureMethodConfiguration = {
  bulkEnabled: boolean;
  guidedEnabled: boolean;
  defaultMethod: CaptureMethod;
};

export const DEFAULT_CAPTURE_METHOD_CONFIGURATION: CaptureMethodConfiguration = {
  bulkEnabled: true,
  guidedEnabled: false,
  defaultMethod: "bulk",
};

function asRecord(value: Json): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function parseCaptureMethodConfiguration(value: Json): CaptureMethodConfiguration {
  const record = asRecord(value);
  const bulkEnabled = record.bulk_enabled !== false;
  const guidedEnabled = record.guided_enabled === true;
  const requestedDefault = record.default_method === "guided" ? "guided" : "bulk";
  const defaultMethod =
    requestedDefault === "guided" && guidedEnabled ? "guided" : bulkEnabled ? "bulk" : "guided";
  return { bulkEnabled, guidedEnabled, defaultMethod };
}

export function captureMethodIsEnabled(
  configuration: CaptureMethodConfiguration,
  method: CaptureMethod,
) {
  return method === "bulk" ? configuration.bulkEnabled : configuration.guidedEnabled;
}
