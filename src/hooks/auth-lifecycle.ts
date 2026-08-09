export type AuthSessionLike = {
  user: {
    id: string;
  };
};

export type AuthorizationResult<TProfile> =
  | { kind: "authorized"; profile: TProfile }
  | { kind: "denied"; message: string }
  | { kind: "transient"; message: string };

export type AuthLifecycleSnapshot<TSession, TProfile> = {
  session: TSession | null;
  profile: TProfile | null;
  initializing: boolean;
  revalidating: boolean;
  authorizationError: string | null;
};

type AuthLifecycleDependencies<TSession extends AuthSessionLike, TProfile> = {
  verifyAuthorization: (userId: string) => Promise<AuthorizationResult<TProfile>>;
  unexpectedVerificationErrorMessage: string;
  signOut: () => Promise<void>;
  onDenied: (message: string) => void;
  onChange: (snapshot: AuthLifecycleSnapshot<TSession, TProfile>) => void;
};

export type AuthLifecycleController<TSession extends AuthSessionLike, TProfile> = {
  handleAuthChange: (event: string, nextSession: TSession | null) => void;
  retryAuthorization: () => void;
  dispose: () => void;
};

export function createAuthLifecycleController<TSession extends AuthSessionLike, TProfile>(
  dependencies: AuthLifecycleDependencies<TSession, TProfile>,
): AuthLifecycleController<TSession, TProfile> {
  let active = true;
  let generation = 0;
  let verifiedUserId: string | null = null;
  let snapshot: AuthLifecycleSnapshot<TSession, TProfile> = {
    session: null,
    profile: null,
    initializing: true,
    revalidating: false,
    authorizationError: null,
  };

  const publish = (next: AuthLifecycleSnapshot<TSession, TProfile>) => {
    if (!active) return;
    snapshot = next;
    dependencies.onChange(next);
  };

  const verify = (nextSession: TSession, background: boolean) => {
    const userId = nextSession.user.id;
    const requestGeneration = ++generation;

    publish({
      ...snapshot,
      session: nextSession,
      initializing: background ? false : true,
      revalidating: background,
      authorizationError: background ? snapshot.authorizationError : null,
    });

    const applyResult = async (result: AuthorizationResult<TProfile>) => {
      if (!active || requestGeneration !== generation || snapshot.session?.user.id !== userId) {
        return;
      }

      if (result.kind === "authorized") {
        verifiedUserId = userId;
        publish({
          session: nextSession,
          profile: result.profile,
          initializing: false,
          revalidating: false,
          authorizationError: null,
        });
        return;
      }

      if (result.kind === "transient") {
        const preserveVerifiedProfile = verifiedUserId === userId && snapshot.profile !== null;
        publish({
          ...snapshot,
          profile: preserveVerifiedProfile ? snapshot.profile : null,
          initializing: false,
          revalidating: false,
          authorizationError: preserveVerifiedProfile ? null : result.message,
        });
        return;
      }

      ++generation;
      verifiedUserId = null;
      publish({
        session: null,
        profile: null,
        initializing: false,
        revalidating: false,
        authorizationError: null,
      });
      dependencies.onDenied(result.message);
      await dependencies.signOut().catch(() => undefined);
    };

    void dependencies.verifyAuthorization(userId).then(applyResult, () =>
      applyResult({
        kind: "transient",
        message: dependencies.unexpectedVerificationErrorMessage,
      }),
    );
  };

  return {
    handleAuthChange(_event, nextSession) {
      if (!active) return;

      if (!nextSession) {
        ++generation;
        verifiedUserId = null;
        publish({
          session: null,
          profile: null,
          initializing: false,
          revalidating: false,
          authorizationError: null,
        });
        return;
      }

      const userId = nextSession.user.id;
      const hasVerifiedProfile = verifiedUserId === userId && snapshot.profile !== null;
      if (!hasVerifiedProfile) {
        verifiedUserId = null;
        publish({
          session: nextSession,
          profile: null,
          initializing: true,
          revalidating: false,
          authorizationError: null,
        });
      }

      verify(nextSession, hasVerifiedProfile);
    },

    retryAuthorization() {
      if (!active || !snapshot.session) return;
      const userId = snapshot.session.user.id;
      verify(snapshot.session, verifiedUserId === userId && snapshot.profile !== null);
    },

    dispose() {
      active = false;
      ++generation;
    },
  };
}
