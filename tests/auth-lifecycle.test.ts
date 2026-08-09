import assert from "node:assert/strict";
import test from "node:test";

import {
  createAuthLifecycleController,
  type AuthLifecycleSnapshot,
  type AuthorizationResult,
} from "../src/hooks/auth-lifecycle.ts";

type TestSession = { accessToken: string; user: { id: string } };
type TestProfile = { id: string; role: "owner" | "staff" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

function createHarness() {
  const snapshots: Array<AuthLifecycleSnapshot<TestSession, TestProfile>> = [];
  const checks: Array<ReturnType<typeof deferred<AuthorizationResult<TestProfile>>>> = [];
  const deniedMessages: string[] = [];
  let signOuts = 0;

  const controller = createAuthLifecycleController<TestSession, TestProfile>({
    verifyAuthorization: () => {
      const check = deferred<AuthorizationResult<TestProfile>>();
      checks.push(check);
      return check.promise;
    },
    unexpectedVerificationErrorMessage: "verification unavailable",
    signOut: async () => {
      signOuts += 1;
    },
    onDenied: (message) => deniedMessages.push(message),
    onChange: (snapshot) => snapshots.push(snapshot),
  });

  return {
    controller,
    snapshots,
    checks,
    deniedMessages,
    signOuts: () => signOuts,
    latest: () => snapshots.at(-1),
  };
}

const session = (accessToken = "token-1", userId = "user-1"): TestSession => ({
  accessToken,
  user: { id: userId },
});

const ownerProfile: TestProfile = { id: "user-1", role: "owner" };

test("initial session remains initializing until authorization succeeds", async () => {
  const harness = createHarness();

  harness.controller.handleAuthChange("INITIAL_SESSION", session());
  assert.deepEqual(harness.latest(), {
    session: session(),
    profile: null,
    initializing: true,
    revalidating: false,
    authorizationError: null,
  });

  harness.checks[0].resolve({ kind: "authorized", profile: ownerProfile });
  await settle();

  assert.deepEqual(harness.latest(), {
    session: session(),
    profile: ownerProfile,
    initializing: false,
    revalidating: false,
    authorizationError: null,
  });
});

test("initial transient failure shows retry state without discarding the session", async () => {
  const harness = createHarness();
  harness.controller.handleAuthChange("INITIAL_SESSION", session());
  harness.checks[0].resolve({ kind: "transient", message: "network unavailable" });
  await settle();

  assert.deepEqual(harness.latest(), {
    session: session(),
    profile: null,
    initializing: false,
    revalidating: false,
    authorizationError: "network unavailable",
  });

  harness.controller.retryAuthorization();
  assert.equal(harness.latest()?.initializing, true);
  harness.checks[1].resolve({ kind: "authorized", profile: ownerProfile });
  await settle();
  assert.equal(harness.latest()?.profile, ownerProfile);
});

test("token refresh and repeated same-user sign-in preserve the verified profile", async () => {
  const harness = createHarness();
  harness.controller.handleAuthChange("INITIAL_SESSION", session());
  harness.checks[0].resolve({ kind: "authorized", profile: ownerProfile });
  await settle();

  const refreshedSession = session("token-2");
  harness.controller.handleAuthChange("TOKEN_REFRESHED", refreshedSession);
  assert.deepEqual(harness.latest(), {
    session: refreshedSession,
    profile: ownerProfile,
    initializing: false,
    revalidating: true,
    authorizationError: null,
  });
  harness.checks[1].resolve({ kind: "authorized", profile: ownerProfile });
  await settle();

  const confirmedSession = session("token-3");
  harness.controller.handleAuthChange("SIGNED_IN", confirmedSession);
  assert.equal(harness.latest()?.profile, ownerProfile);
  assert.equal(harness.latest()?.initializing, false);
  assert.equal(harness.latest()?.revalidating, true);
  harness.checks[2].resolve({ kind: "authorized", profile: ownerProfile });
  await settle();
});

test("transient background verification failure preserves the verified UI", async () => {
  const harness = createHarness();
  harness.controller.handleAuthChange("INITIAL_SESSION", session());
  harness.checks[0].resolve({ kind: "authorized", profile: ownerProfile });
  await settle();

  harness.controller.handleAuthChange("SIGNED_IN", session("token-2"));
  harness.checks[1].resolve({ kind: "transient", message: "network unavailable" });
  await settle();

  assert.deepEqual(harness.latest(), {
    session: session("token-2"),
    profile: ownerProfile,
    initializing: false,
    revalidating: false,
    authorizationError: null,
  });
  assert.equal(harness.signOuts(), 0);
});

test("an unexpected background verification rejection also preserves the verified UI", async () => {
  const harness = createHarness();
  harness.controller.handleAuthChange("INITIAL_SESSION", session());
  harness.checks[0].resolve({ kind: "authorized", profile: ownerProfile });
  await settle();

  harness.controller.handleAuthChange("TOKEN_REFRESHED", session("token-2"));
  harness.checks[1].reject(new Error("fetch failed"));
  await settle();

  assert.equal(harness.latest()?.profile, ownerProfile);
  assert.equal(harness.latest()?.initializing, false);
  assert.equal(harness.latest()?.revalidating, false);
  assert.equal(harness.latest()?.authorizationError, null);
  assert.equal(harness.signOuts(), 0);
});

test("definitive profile deactivation fails closed", async () => {
  const harness = createHarness();
  harness.controller.handleAuthChange("INITIAL_SESSION", session());
  harness.checks[0].resolve({ kind: "authorized", profile: ownerProfile });
  await settle();

  harness.controller.handleAuthChange("TOKEN_REFRESHED", session("token-2"));
  harness.checks[1].resolve({ kind: "denied", message: "account deactivated" });
  await settle();

  assert.equal(harness.latest()?.session, null);
  assert.equal(harness.latest()?.profile, null);
  assert.equal(harness.signOuts(), 1);
  assert.deepEqual(harness.deniedMessages, ["account deactivated"]);
});

test("definitive dealership suspension fails closed", async () => {
  const harness = createHarness();
  harness.controller.handleAuthChange("INITIAL_SESSION", session());
  harness.checks[0].resolve({ kind: "authorized", profile: ownerProfile });
  await settle();

  harness.controller.handleAuthChange("SIGNED_IN", session("token-2"));
  harness.checks[1].resolve({ kind: "denied", message: "dealership suspended" });
  await settle();

  assert.equal(harness.latest()?.session, null);
  assert.equal(harness.latest()?.profile, null);
  assert.equal(harness.signOuts(), 1);
  assert.deepEqual(harness.deniedMessages, ["dealership suspended"]);
});

test("sign-out clears state and a stale authorization response cannot restore it", async () => {
  const harness = createHarness();
  harness.controller.handleAuthChange("INITIAL_SESSION", session());
  harness.controller.handleAuthChange("SIGNED_OUT", null);

  harness.checks[0].resolve({ kind: "authorized", profile: ownerProfile });
  await settle();

  assert.deepEqual(harness.latest(), {
    session: null,
    profile: null,
    initializing: false,
    revalidating: false,
    authorizationError: null,
  });
});

test("a stale user verification cannot overwrite a newer identity", async () => {
  const harness = createHarness();
  harness.controller.handleAuthChange("INITIAL_SESSION", session("token-1", "user-1"));
  harness.controller.handleAuthChange("SIGNED_IN", session("token-2", "user-2"));

  harness.checks[0].resolve({ kind: "authorized", profile: ownerProfile });
  harness.checks[1].resolve({
    kind: "authorized",
    profile: { id: "user-2", role: "staff" },
  });
  await settle();

  assert.equal(harness.latest()?.session?.user.id, "user-2");
  assert.equal(harness.latest()?.profile?.id, "user-2");
});

test("a superseded background check cannot override a manual retry", async () => {
  const harness = createHarness();
  harness.controller.handleAuthChange("INITIAL_SESSION", session());
  harness.checks[0].resolve({ kind: "authorized", profile: ownerProfile });
  await settle();

  harness.controller.handleAuthChange("TOKEN_REFRESHED", session("token-2"));
  harness.controller.retryAuthorization();

  const refreshedProfile: TestProfile = { id: "user-1", role: "staff" };
  harness.checks[2].resolve({ kind: "authorized", profile: refreshedProfile });
  await settle();
  harness.checks[1].resolve({ kind: "denied", message: "stale denial" });
  await settle();

  assert.equal(harness.latest()?.profile, refreshedProfile);
  assert.equal(harness.signOuts(), 0);
  assert.deepEqual(harness.deniedMessages, []);
});
