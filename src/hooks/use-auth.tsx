import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

type Profile = {
  id: string;
  email: string;
  full_name: string | null;
  role: "owner" | "dealer_admin" | "staff";
  dealership_id: string | null;
  status: "active" | "deactivated";
};

type AuthContextValue = {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  authorizationError: string | null;
  retryAuthorization: () => void;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [authorizationError, setAuthorizationError] = useState<string | null>(null);
  const [authorizationAttempt, setAuthorizationAttempt] = useState(0);

  useEffect(() => {
    let active = true;

    const rejectSession = async (message: string) => {
      if (!active) return;
      setProfile(null);
      setAuthorizationError(null);
      window.alert(message);
      await supabase.auth.signOut();
    };

    const failAuthorizationCheck = (message: string) => {
      if (!active) return;
      setProfile(null);
      setAuthorizationError(message);
    };

    const loadProfile = async (userId: string) => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, email, full_name, role, dealership_id, status")
        .eq("id", userId)
        .maybeSingle();

      if (!active) return;
      const nextProfile = data as Profile | null;
      if (error) {
        failAuthorizationCheck("We couldn't verify your account. Check your connection and retry.");
        return;
      }
      if (!nextProfile) {
        await rejectSession("Your account is unavailable. Contact your administrator.");
        return;
      }
      if (nextProfile.status !== "active") {
        await rejectSession("Your account has been deactivated. Contact your administrator.");
        return;
      }

      if (nextProfile.role !== "owner") {
        if (!nextProfile.dealership_id) {
          await rejectSession("Your account is not assigned to a dealership. Contact support.");
          return;
        }

        const { data: dealership, error: dealershipError } = await supabase
          .from("dealerships")
          .select("status, subscription_status")
          .eq("id", nextProfile.dealership_id)
          .maybeSingle();

        if (dealershipError) {
          failAuthorizationCheck(
            "We couldn't verify your dealership access. Check your connection and retry.",
          );
          return;
        }
        if (
          !dealership ||
          !["active", "trial"].includes(dealership.status) ||
          dealership.subscription_status !== "active"
        ) {
          await rejectSession("Your dealership account is not active. Contact support.");
          return;
        }
      }

      setProfile(nextProfile);
      setAuthorizationError(null);
    };

    const resolveSession = async (nextSession: Session | null) => {
      if (!active) return;
      setLoading(true);
      setSession(nextSession);
      setProfile(null);
      setAuthorizationError(null);
      if (nextSession?.user) {
        await loadProfile(nextSession.user.id);
      } else {
        setProfile(null);
      }
      if (active) setLoading(false);
    };

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setTimeout(() => {
        void resolveSession(nextSession);
      }, 0);
    });

    void supabase.auth.getSession().then(({ data, error }) => {
      if (error) {
        if (active) {
          setSession(null);
          failAuthorizationCheck(
            "We couldn't restore your session. Check your connection and retry.",
          );
          setLoading(false);
        }
        return;
      }
      void resolveSession(data.session);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [authorizationAttempt]);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const retryAuthorization = () => {
    setAuthorizationAttempt((attempt) => attempt + 1);
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        user: session?.user ?? null,
        profile,
        loading,
        authorizationError,
        retryAuthorization,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
