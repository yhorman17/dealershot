import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";

const STORAGE_KEY = "dealershot:impersonation";

type ImpersonationState = {
  dealershipId: string;
  dealershipName: string;
  logId: string;
};

type ImpersonationContextValue = {
  impersonation: ImpersonationState | null;
  start: (dealership: { id: string; name: string }) => Promise<void>;
  end: () => Promise<void>;
  effectiveDealershipId: string | null;
};

const ImpersonationContext = createContext<ImpersonationContextValue | undefined>(undefined);

export function ImpersonationProvider({ children }: { children: ReactNode }) {
  const { user, profile } = useAuth();
  const [impersonation, setImpersonation] = useState<ImpersonationState | null>(null);

  // Hydrate from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setImpersonation(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  // Clear if user is no longer an owner
  useEffect(() => {
    if (profile && profile.role !== "owner" && impersonation) {
      setImpersonation(null);
      localStorage.removeItem(STORAGE_KEY);
    }
  }, [profile, impersonation]);

  const start = useCallback(
    async (d: { id: string; name: string }) => {
      if (!user) return;
      const { data, error } = await supabase
        .from("impersonation_logs")
        .insert({ owner_id: user.id, dealership_id: d.id })
        .select("id")
        .single();
      if (error) {
        alert("Failed to start impersonation: " + error.message);
        return;
      }
      const state: ImpersonationState = {
        dealershipId: d.id,
        dealershipName: d.name,
        logId: data.id,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      setImpersonation(state);
    },
    [user],
  );

  const end = useCallback(async () => {
    if (!impersonation) return;
    await supabase
      .from("impersonation_logs")
      .update({ ended_at: new Date().toISOString() })
      .eq("id", impersonation.logId);
    localStorage.removeItem(STORAGE_KEY);
    setImpersonation(null);
  }, [impersonation]);

  const effectiveDealershipId = impersonation?.dealershipId ?? profile?.dealership_id ?? null;

  return (
    <ImpersonationContext.Provider value={{ impersonation, start, end, effectiveDealershipId }}>
      {children}
    </ImpersonationContext.Provider>
  );
}

export function useImpersonation() {
  const ctx = useContext(ImpersonationContext);
  if (!ctx) throw new Error("useImpersonation must be used within ImpersonationProvider");
  return ctx;
}
