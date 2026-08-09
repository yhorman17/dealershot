import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import {
  createAuthLifecycleController,
  type AuthLifecycleController,
  type AuthorizationResult,
} from "@/hooks/auth-lifecycle";
import { toast } from "sonner";

type Profile = {
  id: string;
  email: string;
  full_name: string | null;
  role: "owner" | "dealer_admin" | "staff";
  dealership_id: string | null;
  status: "active" | "deactivated";
  password_change_required: boolean;
};

type AuthContextValue = {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  revalidating: boolean;
  authorizationError: string | null;
  retryAuthorization: () => void;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

async function verifyAuthorization(userId: string): Promise<AuthorizationResult<Profile>> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, full_name, role, dealership_id, status")
    .eq("id", userId)
    .maybeSingle();

  const nextProfile = data as Profile | null;
  if (error) {
    return {
      kind: "transient",
      message: "We couldn't verify your account. Check your connection and retry.",
    };
  }
  if (!nextProfile) {
    return {
      kind: "denied",
      message: "Your account is unavailable. Contact your administrator.",
    };
  }
  if (nextProfile.status !== "active") {
    return {
      kind: "denied",
      message: "Your account has been deactivated. Contact your administrator.",
    };
  }

  const { data: onboarding, error: onboardingError } = await supabase
    .from("user_onboarding")
    .select("onboarding_state, password_change_required")
    .eq("profile_id", userId)
    .maybeSingle();
  if (onboardingError) {
    return {
      kind: "transient",
      message: "We couldn't verify your account setup. Check your connection and retry.",
    };
  }
  if (!onboarding) {
    return {
      kind: "denied",
      message: "Your account setup is incomplete. Contact your administrator.",
    };
  }

  const authorizedProfile: Profile = {
    ...nextProfile,
    password_change_required:
      onboarding.password_change_required || onboarding.onboarding_state !== "complete",
  };

  // Password-gated users may load only their own profile and onboarding row.
  // Database authorization helpers independently deny every business table.
  if (authorizedProfile.password_change_required) {
    return { kind: "authorized", profile: authorizedProfile };
  }

  if (nextProfile.role !== "owner") {
    const { data: dealership, error: dealershipError } = await supabase
      .from("dealerships")
      .select("id")
      .limit(1)
      .maybeSingle();

    if (dealershipError) {
      return {
        kind: "transient",
        message: "We couldn't verify your dealership access. Check your connection and retry.",
      };
    }
    if (!dealership) {
      return {
        kind: "denied",
        message: "Your dealership account is not active. Contact support.",
      };
    }
  }

  return { kind: "authorized", profile: authorizedProfile };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [revalidating, setRevalidating] = useState(false);
  const [authorizationError, setAuthorizationError] = useState<string | null>(null);
  const controllerRef = useRef<AuthLifecycleController<Session, Profile> | null>(null);

  useEffect(() => {
    const controller = createAuthLifecycleController<Session, Profile>({
      verifyAuthorization,
      unexpectedVerificationErrorMessage:
        "We couldn't verify your account. Check your connection and retry.",
      signOut: () => supabase.auth.signOut().then(() => undefined),
      onDenied: (message) => toast.error("Access unavailable", { description: message }),
      onChange: (next) => {
        setSession(next.session);
        setProfile(next.profile);
        setLoading(next.initializing);
        setRevalidating(next.revalidating);
        setAuthorizationError(next.authorizationError);
      },
    });
    controllerRef.current = controller;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setTimeout(() => {
        controller.handleAuthChange(event, nextSession);
      }, 0);
    });

    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
      subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const retryAuthorization = () => {
    controllerRef.current?.retryAuthorization();
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        user: session?.user ?? null,
        profile,
        loading,
        revalidating,
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
