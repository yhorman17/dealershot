import { useCallback, useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import {
  DEFAULT_CAPTURE_METHOD_CONFIGURATION,
  parseCaptureMethodConfiguration,
} from "@/lib/capture-methods";

export * from "@/lib/capture-methods";

export function useCaptureMethods(dealershipId: string | null | undefined) {
  const [configuration, setConfiguration] = useState(DEFAULT_CAPTURE_METHOD_CONFIGURATION);
  const [loading, setLoading] = useState(Boolean(dealershipId));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!dealershipId) {
      setConfiguration(DEFAULT_CAPTURE_METHOD_CONFIGURATION);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    const { data, error: requestError } = await supabase.rpc("get_capture_method_configuration", {
      _dealership_id: dealershipId,
    });
    if (requestError) {
      setError(requestError.message);
    } else {
      setConfiguration(parseCaptureMethodConfiguration(data));
      setError(null);
    }
    setLoading(false);
  }, [dealershipId]);

  useEffect(() => void load(), [load]);

  return { configuration, loading, error, reload: load };
}
