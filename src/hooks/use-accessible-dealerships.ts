import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";

export type AccessibleDealership = {
  id: string;
  name: string;
  status: string;
  subscription_status: string;
};

export function useAccessibleDealerships(requestedDealershipId?: string) {
  const { profile } = useAuth();
  const profileId = profile?.id;
  const primaryDealershipId = profile?.dealership_id;
  const [dealerships, setDealerships] = useState<AccessibleDealership[]>([]);
  const [selectedDealershipId, setSelectedDealershipId] = useState<string | null>(null);
  const [loadingDealerships, setLoadingDealerships] = useState(true);
  const [dealershipError, setDealershipError] = useState<string | null>(null);

  useEffect(() => {
    if (!profileId) {
      setDealerships([]);
      setSelectedDealershipId(null);
      setLoadingDealerships(false);
      return;
    }

    let cancelled = false;
    setLoadingDealerships(true);
    setDealershipError(null);
    void supabase
      .from("dealerships")
      .select("id, name, status, subscription_status")
      .order("name")
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setDealerships([]);
          setSelectedDealershipId(null);
          setDealershipError("Dealership access could not be loaded.");
          setLoadingDealerships(false);
          return;
        }

        const list = (data as AccessibleDealership[]) ?? [];
        setDealerships(list);
        setSelectedDealershipId((current) => {
          const canUse = (id: string | null | undefined) =>
            Boolean(id && list.some((item) => item.id === id));
          if (canUse(requestedDealershipId)) return requestedDealershipId ?? null;
          if (canUse(current)) return current;
          if (canUse(primaryDealershipId)) return primaryDealershipId ?? null;
          return list[0]?.id ?? null;
        });
        setLoadingDealerships(false);
      });

    return () => {
      cancelled = true;
    };
  }, [profileId, primaryDealershipId, requestedDealershipId]);

  const selectedDealership = useMemo(
    () => dealerships.find((item) => item.id === selectedDealershipId) ?? null,
    [dealerships, selectedDealershipId],
  );

  return {
    dealerships,
    selectedDealership,
    selectedDealershipId,
    setSelectedDealershipId,
    loadingDealerships,
    dealershipError,
    canSwitchDealerships: profile?.role === "owner" || dealerships.length > 1,
  };
}
