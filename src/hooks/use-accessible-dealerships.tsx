import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { activeStorePreferenceKey, chooseAuthorizedStoreId } from "@/lib/active-store";

export type AccessibleDealership = {
  id: string;
  name: string;
  status: string;
  subscription_status: string;
  organization_id: string;
  organization_name: string | null;
};

export type StoreCapabilities = {
  capture: boolean;
  media: boolean;
  documents: boolean;
  reports: boolean;
  settings: boolean;
};

type ActiveDealershipContextValue = {
  dealerships: AccessibleDealership[];
  selectedDealership: AccessibleDealership | null;
  selectedDealershipId: string | null;
  setSelectedDealershipId: (dealershipId: string | null) => void;
  loadingDealerships: boolean;
  dealershipError: string | null;
  canSwitchDealerships: boolean;
  capabilities: StoreCapabilities | null;
  loadingCapabilities: boolean;
};

const ActiveDealershipContext = createContext<ActiveDealershipContextValue | null>(null);

export function ActiveDealershipProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  const profileId = profile?.id;
  const primaryDealershipId = profile?.dealership_id;
  const [dealerships, setDealerships] = useState<AccessibleDealership[]>([]);
  const [selectedDealershipId, setSelectedDealershipIdState] = useState<string | null>(null);
  const [loadingDealerships, setLoadingDealerships] = useState(true);
  const [dealershipError, setDealershipError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<StoreCapabilities | null>(null);
  const [loadingCapabilities, setLoadingCapabilities] = useState(profile?.role === "staff");

  useEffect(() => {
    if (!profileId) {
      setDealerships([]);
      setSelectedDealershipIdState(null);
      setLoadingDealerships(false);
      return;
    }

    let cancelled = false;
    setLoadingDealerships(true);
    setDealershipError(null);
    setDealerships([]);
    setSelectedDealershipIdState(null);

    void (async () => {
      const { data, error } = await supabase
        .from("dealerships")
        .select("id, name, status, subscription_status, organization_id")
        .order("name");
      if (cancelled) return;
      if (error) {
        setDealershipError("Dealership access could not be loaded.");
        setLoadingDealerships(false);
        return;
      }

      const storeRows = (data as Array<Omit<AccessibleDealership, "organization_name">>) ?? [];
      const organizationIds = [...new Set(storeRows.map((item) => item.organization_id))];
      const organizationNames = new Map<string, string>();
      if (organizationIds.length) {
        const { data: organizations } = await supabase
          .from("organizations")
          .select("id, name")
          .in("id", organizationIds);
        if (cancelled) return;
        for (const organization of organizations ?? []) {
          organizationNames.set(organization.id, organization.name);
        }
      }

      const list = storeRows.map((item) => ({
        ...item,
        organization_name: organizationNames.get(item.organization_id) ?? null,
      }));
      let persistedId: string | null = null;
      try {
        persistedId = window.localStorage.getItem(activeStorePreferenceKey(profileId));
      } catch {
        // Storage can be unavailable in privacy-restricted browser contexts.
      }

      const nextId = chooseAuthorizedStoreId(
        list.map((item) => item.id),
        persistedId,
        primaryDealershipId,
      );
      setDealerships(list);
      setSelectedDealershipIdState(nextId);
      setLoadingDealerships(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [primaryDealershipId, profileId]);

  useEffect(() => {
    if (profile?.role !== "staff") {
      setCapabilities(null);
      setLoadingCapabilities(false);
      return;
    }
    if (!selectedDealershipId) {
      setCapabilities(null);
      setLoadingCapabilities(loadingDealerships);
      return;
    }
    let cancelled = false;
    setCapabilities(null);
    setLoadingCapabilities(true);
    void supabase
      .rpc("get_current_user_store_capabilities", { _dealership_id: selectedDealershipId })
      .then(({ data, error }) => {
        if (cancelled) return;
        setCapabilities(error ? null : (data as StoreCapabilities));
        setLoadingCapabilities(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadingDealerships, profile?.role, selectedDealershipId]);

  const setSelectedDealershipId = useCallback(
    (dealershipId: string | null) => {
      const authorized = dealershipId
        ? dealerships.some((item) => item.id === dealershipId)
        : dealerships.length === 0;
      if (!authorized) return;
      setSelectedDealershipIdState(dealershipId);
      if (!profileId) return;
      try {
        if (dealershipId) {
          window.localStorage.setItem(activeStorePreferenceKey(profileId), dealershipId);
        } else {
          window.localStorage.removeItem(activeStorePreferenceKey(profileId));
        }
      } catch {
        // The in-memory selection remains valid when browser persistence is unavailable.
      }
    },
    [dealerships, profileId],
  );

  const selectedDealership = useMemo(
    () => dealerships.find((item) => item.id === selectedDealershipId) ?? null,
    [dealerships, selectedDealershipId],
  );
  const value = useMemo<ActiveDealershipContextValue>(
    () => ({
      dealerships,
      selectedDealership,
      selectedDealershipId,
      setSelectedDealershipId,
      loadingDealerships,
      dealershipError,
      canSwitchDealerships: dealerships.length > 1,
      capabilities,
      loadingCapabilities,
    }),
    [
      dealershipError,
      capabilities,
      dealerships,
      loadingDealerships,
      loadingCapabilities,
      selectedDealership,
      selectedDealershipId,
      setSelectedDealershipId,
    ],
  );

  return (
    <ActiveDealershipContext.Provider value={value}>{children}</ActiveDealershipContext.Provider>
  );
}

export function useAccessibleDealerships(requestedDealershipId?: string) {
  const context = useContext(ActiveDealershipContext);
  if (!context) {
    throw new Error("useAccessibleDealerships must be used inside ActiveDealershipProvider");
  }

  useEffect(() => {
    if (
      requestedDealershipId &&
      requestedDealershipId !== context.selectedDealershipId &&
      context.dealerships.some((item) => item.id === requestedDealershipId)
    ) {
      context.setSelectedDealershipId(requestedDealershipId);
    }
  }, [context, requestedDealershipId]);

  return {
    ...context,
    requestedDealershipDenied: Boolean(
      requestedDealershipId &&
      !context.loadingDealerships &&
      !context.dealerships.some((item) => item.id === requestedDealershipId),
    ),
  };
}
