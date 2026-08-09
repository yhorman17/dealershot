import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const PROTECTED_PROJECT_CONFIRMATIONS = new Map([
  ["oyuvdarrkwpqmufzidnc", "validate-authorized-dealershot:oyuvdarrkwpqmufzidnc"],
]);

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function randomPassword() {
  return `Aa1!${randomBytes(24).toString("base64url")}`;
}

function client(url, key) {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/eyJ[A-Za-z0-9._-]+/g, "[REDACTED_JWT]")
    .replace(/(?:postgres(?:ql)?|https?):\/\/\S+/gi, "[REDACTED_URL]")
    .slice(0, 500);
}

function assertNoError(result, label) {
  if (result.error) throw new Error(`${label}: ${safeMessage(result.error)}`);
  return result.data;
}

function assertDenied(result, label) {
  if (!result.error) throw new Error(`${label}: request unexpectedly succeeded`);
}

async function waitForProfile(admin, id) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await admin.from("profiles").select("id").eq("id", id).maybeSingle();
    if (result.data) return;
    if (result.error) throw result.error;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Auth profile trigger did not materialize within ten seconds.");
}

const projectRef = requiredEnv("DEALERSHOT_VALIDATION_PROJECT_REF");
const supabaseUrl = requiredEnv("SUPABASE_URL");
const publishableKey = requiredEnv("SUPABASE_PUBLISHABLE_KEY");
const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const confirmation = requiredEnv("DEALERSHOT_VALIDATION_CONFIRM");
const parsedUrl = new URL(supabaseUrl);

if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== `${projectRef}.supabase.co`) {
  throw new Error("SUPABASE_URL must match the explicitly named project reference.");
}

const protectedConfirmation = PROTECTED_PROJECT_CONFIRMATIONS.get(projectRef);
const expectedConfirmation = protectedConfirmation ?? `validate-disposable:${projectRef}`;
if (confirmation !== expectedConfirmation) {
  const targetKind = protectedConfirmation ? "authorized protected" : "disposable";
  throw new Error(
    `Safety stop: DEALERSHOT_VALIDATION_CONFIRM does not authorize this ${targetKind} project.`,
  );
}

const admin = client(supabaseUrl, serviceRoleKey);
const runId = randomBytes(6).toString("hex");
const emailPrefix = `dealershot-phase1-${runId}`;
const createdUsers = [];
const storageObjects = [];
const results = [];
let existingSessionAfterReset = "not_observed";

async function check(name, operation) {
  await operation();
  results.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

async function createIdentity(label, role, dealershipIds, options = {}) {
  const email = `${emailPrefix}-${label}@example.com`;
  const password = randomPassword();
  const authResult = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `Validation ${label}` },
  });
  const user = assertNoError(authResult, `create ${label}`).user;
  assert.ok(user?.id);
  createdUsers.push(user.id);
  await waitForProfile(admin, user.id);

  const primary = dealershipIds[0] ?? null;
  assertNoError(
    await admin
      .from("profiles")
      .update({
        role,
        dealership_id: role === "owner" ? null : primary,
        status: options.status ?? "active",
      })
      .eq("id", user.id),
    `configure ${label} profile`,
  );
  if (dealershipIds.length) {
    assertNoError(
      await admin.from("profile_dealerships").upsert(
        dealershipIds.map((dealership_id) => ({ profile_id: user.id, dealership_id })),
        {
          onConflict: "profile_id,dealership_id",
          ignoreDuplicates: true,
        },
      ),
      `configure ${label} memberships`,
    );
  }
  assertNoError(
    await admin
      .from("user_onboarding")
      .update({
        onboarding_method: "existing",
        onboarding_state: "complete",
        password_change_required: false,
        completed_at: new Date().toISOString(),
        password_changed_at: new Date().toISOString(),
      })
      .eq("profile_id", user.id),
    `configure ${label} onboarding`,
  );
  return { id: user.id, email, password };
}

async function authenticated(identity) {
  const scoped = client(supabaseUrl, publishableKey);
  const auth = await scoped.auth.signInWithPassword({
    email: identity.email,
    password: identity.password,
  });
  assertNoError(auth, `sign in ${identity.email}`);
  assert.ok(auth.data.session?.access_token);
  return { scoped, session: auth.data.session };
}

async function provisionTemporary(actorId, dealershipId) {
  const email = `${emailPrefix}-temporary@example.com`;
  const password = randomPassword();
  const idempotencyKey = randomUUID();
  const begin = assertNoError(
    await admin.rpc("begin_user_provisioning_operation", {
      _actor_id: actorId,
      _idempotency_key: idempotencyKey,
      _email: email,
      _full_name: "Validation Temporary Staff",
      _role: "staff",
      _dealership_ids: [dealershipId],
    }),
    "begin temporary provisioning",
  );
  const operationId = begin.operation_id;
  assert.ok(operationId);
  assertNoError(
    await admin.rpc("mark_user_account_operation", {
      _actor_id: actorId,
      _operation_id: operationId,
      _status: "auth_pending",
    }),
    "mark temporary provisioning pending",
  );
  const authResult = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Validation Temporary Staff" },
  });
  const user = assertNoError(authResult, "create temporary Auth user").user;
  assert.ok(user?.id);
  createdUsers.push(user.id);
  await waitForProfile(admin, user.id);
  assertNoError(
    await admin.rpc("mark_user_account_operation", {
      _actor_id: actorId,
      _operation_id: operationId,
      _status: "auth_updated",
      _target_profile_id: user.id,
    }),
    "mark temporary Auth update",
  );
  assertNoError(
    await admin.rpc("finalize_user_provisioning_operation", {
      _actor_id: actorId,
      _operation_id: operationId,
      _auth_user_id: user.id,
    }),
    "finalize temporary provisioning",
  );
  return { id: user.id, email, password, operationId, idempotencyKey };
}

async function cleanup() {
  for (const { bucket, path } of storageObjects.reverse()) {
    await admin.storage.from(bucket).remove([path]);
  }
  await admin.from("user_account_operations").delete().like("target_email", `${emailPrefix}%`);
  await admin.from("platform_settings").delete().like("setting_key", `validation.${runId}.%`);
  for (const id of createdUsers.reverse()) await admin.auth.admin.deleteUser(id);
  if (globalThis.validationDealershipIds?.length) {
    await admin.from("dealerships").delete().in("id", globalThis.validationDealershipIds);
  }
}

try {
  const dealershipA = randomUUID();
  const dealershipB = randomUUID();
  const dealershipSuspended = randomUUID();
  globalThis.validationDealershipIds = [dealershipA, dealershipB, dealershipSuspended];

  await check("hosted project health and migrated schema", async () => {
    const health = await fetch(`${supabaseUrl}/auth/v1/health`, {
      headers: { apikey: publishableKey },
    });
    assert.equal(health.ok, true);
    assertNoError(
      await admin.from("user_onboarding").select("profile_id").limit(1),
      "schema probe",
    );
  });

  assertNoError(
    await admin.from("dealerships").insert([
      {
        id: dealershipA,
        name: `Validation A ${runId}`,
        status: "active",
        subscription_status: "active",
      },
      {
        id: dealershipB,
        name: `Validation B ${runId}`,
        status: "active",
        subscription_status: "active",
      },
      {
        id: dealershipSuspended,
        name: `Validation Suspended ${runId}`,
        status: "suspended",
        subscription_status: "active",
      },
    ]),
    "create dealerships",
  );

  const owner = await createIdentity("owner", "owner", []);
  const adminA = await createIdentity("admin-a", "dealer_admin", [dealershipA]);
  const adminB = await createIdentity("admin-b", "dealer_admin", [dealershipB]);
  const multiAdmin = await createIdentity("admin-multi", "dealer_admin", [
    dealershipA,
    dealershipB,
  ]);
  const staffA = await createIdentity("staff-a", "staff", [dealershipA]);
  const staffB = await createIdentity("staff-b", "staff", [dealershipB]);
  const deactivated = await createIdentity("deactivated", "staff", [dealershipA], {
    status: "deactivated",
  });
  const suspendedStaff = await createIdentity("suspended", "staff", [dealershipSuspended]);

  assertNoError(
    await admin.from("vehicles").insert([
      { id: randomUUID(), dealership_id: dealershipA, stock_number: `A-${runId}` },
      { id: randomUUID(), dealership_id: dealershipB, stock_number: `B-${runId}` },
      { id: randomUUID(), dealership_id: dealershipSuspended, stock_number: `S-${runId}` },
    ]),
    "create tenant data",
  );

  const ownerAuth = await authenticated(owner);
  const adminAAuth = await authenticated(adminA);
  const adminBAuth = await authenticated(adminB);
  const multiAuth = await authenticated(multiAdmin);
  let staffAAuth = await authenticated(staffA);
  const staffBAuth = await authenticated(staffB);
  const deactivatedAuth = await authenticated(deactivated);
  const suspendedAuth = await authenticated(suspendedStaff);

  await check("real JWT tenant reads", async () => {
    assert.equal(
      assertNoError(await ownerAuth.scoped.from("vehicles").select("id"), "owner vehicles").length,
      3,
    );
    assert.equal(
      assertNoError(await adminAAuth.scoped.from("vehicles").select("id"), "admin A vehicles")
        .length,
      1,
    );
    assert.equal(
      assertNoError(await adminBAuth.scoped.from("vehicles").select("id"), "admin B vehicles")
        .length,
      1,
    );
    assert.equal(
      assertNoError(await multiAuth.scoped.from("vehicles").select("id"), "multi-admin vehicles")
        .length,
      2,
    );
    assert.equal(
      assertNoError(await staffAAuth.scoped.from("vehicles").select("id"), "staff A vehicles")
        .length,
      1,
    );
    assert.equal(
      assertNoError(await staffBAuth.scoped.from("vehicles").select("id"), "staff B vehicles")
        .length,
      1,
    );
    assert.equal(
      assertNoError(
        await deactivatedAuth.scoped.from("vehicles").select("id"),
        "deactivated vehicles",
      ).length,
      0,
    );
    assert.equal(
      assertNoError(await suspendedAuth.scoped.from("vehicles").select("id"), "suspended vehicles")
        .length,
      0,
    );
  });

  await check("real JWT cross-tenant writes", async () => {
    assertDenied(
      await adminAAuth.scoped
        .from("vehicles")
        .insert({ dealership_id: dealershipB, stock_number: `X-${runId}` }),
      "admin A cross-tenant insert",
    );
    assertDenied(
      await staffAAuth.scoped
        .from("vehicles")
        .update({ dealership_id: dealershipB })
        .eq("stock_number", `A-${runId}`),
      "staff A cross-tenant update",
    );
  });

  await check("server-only provisioning scope", async () => {
    assertDenied(
      await admin.rpc("begin_user_provisioning_operation", {
        _actor_id: adminA.id,
        _idempotency_key: randomUUID(),
        _email: `${emailPrefix}-forbidden-admin@example.com`,
        _full_name: "Forbidden Admin",
        _role: "dealer_admin",
        _dealership_ids: [dealershipA],
      }),
      "dealer admin creates dealer admin",
    );
    assertDenied(
      await admin.rpc("begin_user_provisioning_operation", {
        _actor_id: adminA.id,
        _idempotency_key: randomUUID(),
        _email: `${emailPrefix}-cross-staff@example.com`,
        _full_name: "Cross Tenant Staff",
        _role: "staff",
        _dealership_ids: [dealershipB],
      }),
      "dealer admin cross-tenant staff",
    );
    assertDenied(
      await staffAAuth.scoped.rpc("begin_user_provisioning_operation", {
        _actor_id: staffA.id,
        _idempotency_key: randomUUID(),
        _email: `${emailPrefix}-staff-attempt@example.com`,
        _full_name: "Staff Attempt",
        _role: "staff",
        _dealership_ids: [dealershipA],
      }),
      "staff direct provisioning RPC",
    );
  });

  const temporary = await provisionTemporary(owner.id, dealershipA);
  const temporaryAuth = await authenticated(temporary);
  await check("temporary-login direct Data API gate", async () => {
    assert.equal(
      assertNoError(await temporaryAuth.scoped.from("vehicles").select("id"), "temporary vehicles")
        .length,
      0,
    );
    assert.equal(
      assertNoError(
        await temporaryAuth.scoped.from("user_onboarding").select("profile_id"),
        "temporary onboarding",
      ).length,
      1,
    );
  });

  await check("permanent password completion", async () => {
    const permanentPassword = randomPassword();
    assertNoError(
      await admin.auth.admin.updateUserById(temporary.id, { password: permanentPassword }),
      "hosted Admin password completion",
    );
    assertNoError(
      await admin.rpc("complete_temporary_password_onboarding", { _actor_id: temporary.id }),
      "complete onboarding",
    );
    temporary.password = permanentPassword;
    const permanentAuth = await authenticated(temporary);
    assert.equal(
      assertNoError(await permanentAuth.scoped.from("vehicles").select("id"), "completed vehicles")
        .length,
      1,
    );
  });

  await check("native invitation identity and acceptance regression", async () => {
    const invitationToken = `${randomUUID()}-${randomUUID()}`;
    const invitedEmail = `${emailPrefix}-invited@example.com`;
    const invitedPassword = randomPassword();
    assertNoError(
      await admin.from("user_invitations").insert({
        email: invitedEmail,
        full_name: "Validation Invited Staff",
        role: "staff",
        dealership_id: dealershipA,
        invited_by: owner.id,
        token: invitationToken,
      }),
      "create invitation record",
    );
    const generated = assertNoError(
      await admin.auth.admin.generateLink({
        type: "invite",
        email: invitedEmail,
        options: {
          redirectTo: `https://example.invalid/accept-invite?token=${encodeURIComponent(invitationToken)}`,
          data: { full_name: "Validation Invited Staff", invitation_token: invitationToken },
        },
      }),
      "generate native invite link",
    );
    assert.ok(generated.user?.id);
    createdUsers.push(generated.user.id);
    await waitForProfile(admin, generated.user.id);
    assertNoError(
      await admin.auth.admin.updateUserById(generated.user.id, { password: invitedPassword }),
      "set invite test password",
    );
    assertDenied(
      await staffBAuth.scoped.rpc("accept_invitation", { _token: invitationToken }),
      "wrong-email invitation acceptance",
    );
    const invited = { id: generated.user.id, email: invitedEmail, password: invitedPassword };
    const invitedAuth = await authenticated(invited);
    assertNoError(
      await invitedAuth.scoped.rpc("accept_invitation", { _token: invitationToken }),
      "accept invitation",
    );
    assert.equal(
      assertNoError(await invitedAuth.scoped.from("vehicles").select("id"), "invited tenant access")
        .length,
      1,
    );

    const ownerInviteToken = `${randomUUID()}-${randomUUID()}`;
    const ownerInviteEmail = `${emailPrefix}-owner-invite@example.com`;
    const ownerInvitePassword = randomPassword();
    assertNoError(
      await admin.from("user_invitations").insert({
        email: ownerInviteEmail,
        full_name: "Forbidden Invited Owner",
        role: "owner",
        dealership_id: dealershipA,
        invited_by: owner.id,
        token: ownerInviteToken,
      }),
      "create owner-role invitation fixture",
    );
    const ownerInviteUser = assertNoError(
      await admin.auth.admin.createUser({
        email: ownerInviteEmail,
        password: ownerInvitePassword,
        email_confirm: true,
      }),
      "create owner invitation identity",
    ).user;
    assert.ok(ownerInviteUser?.id);
    createdUsers.push(ownerInviteUser.id);
    await waitForProfile(admin, ownerInviteUser.id);
    const ownerInviteAuth = await authenticated({
      id: ownerInviteUser.id,
      email: ownerInviteEmail,
      password: ownerInvitePassword,
    });
    assertDenied(
      await ownerInviteAuth.scoped.rpc("accept_invitation", { _token: ownerInviteToken }),
      "owner-role invitation acceptance",
    );
  });

  await check("admin reset contains existing JWT before Auth mutation", async () => {
    const oldPassword = staffA.password;
    const existingAccessToken = staffAAuth.session.access_token;
    const resetPassword = randomPassword();
    const idempotencyKey = randomUUID();
    const begin = assertNoError(
      await admin.rpc("begin_temporary_password_reset_operation", {
        _actor_id: owner.id,
        _idempotency_key: idempotencyKey,
        _target_profile_id: staffA.id,
      }),
      "begin reset",
    );
    assert.equal(
      assertNoError(await staffAAuth.scoped.from("vehicles").select("id"), "contained session")
        .length,
      0,
    );
    assertDenied(
      await admin.rpc("begin_temporary_password_reset_operation", {
        _actor_id: owner.id,
        _idempotency_key: randomUUID(),
        _target_profile_id: staffA.id,
      }),
      "concurrent reset",
    );
    assertNoError(
      await admin.rpc("mark_user_account_operation", {
        _actor_id: owner.id,
        _operation_id: begin.operation_id,
        _status: "auth_pending",
        _target_profile_id: staffA.id,
      }),
      "mark reset pending",
    );
    assertNoError(
      await admin.auth.admin.updateUserById(staffA.id, { password: resetPassword }),
      "hosted Admin reset",
    );
    const existingUser = await admin.auth.getUser(existingAccessToken);
    existingSessionAfterReset = existingUser.error ? "revoked" : "valid";
    assertNoError(
      await admin.rpc("mark_user_account_operation", {
        _actor_id: owner.id,
        _operation_id: begin.operation_id,
        _status: "auth_updated",
        _target_profile_id: staffA.id,
      }),
      "mark reset updated",
    );
    assertNoError(
      await admin.rpc("finalize_temporary_password_reset_operation", {
        _actor_id: owner.id,
        _operation_id: begin.operation_id,
      }),
      "finalize reset",
    );
    const oldAttempt = await client(supabaseUrl, publishableKey).auth.signInWithPassword({
      email: staffA.email,
      password: oldPassword,
    });
    assert.ok(oldAttempt.error);
    staffA.password = resetPassword;
    const resetAuth = await authenticated(staffA);
    assert.equal(
      assertNoError(await resetAuth.scoped.from("vehicles").select("id"), "reset-gated vehicles")
        .length,
      0,
    );
    const permanentPassword = randomPassword();
    assertNoError(
      await admin.auth.admin.updateUserById(staffA.id, { password: permanentPassword }),
      "second permanent password",
    );
    assertNoError(
      await admin.rpc("complete_temporary_password_onboarding", { _actor_id: staffA.id }),
      "complete reset onboarding",
    );
    staffA.password = permanentPassword;
    staffAAuth = await authenticated(staffA);
    assert.equal(
      assertNoError(await staffAAuth.scoped.from("vehicles").select("id"), "restored vehicles")
        .length,
      1,
    );
  });

  await check("settings and append-only audit", async () => {
    const platformKey = `validation.${runId}.platform`;
    assertNoError(
      await admin.rpc("admin_set_platform_setting", {
        _actor_id: owner.id,
        _setting_key: platformKey,
        _setting_value: { enabled: true },
      }),
      "owner platform setting",
    );
    assertDenied(
      await admin.rpc("admin_set_platform_setting", {
        _actor_id: adminA.id,
        _setting_key: `${platformKey}.forbidden`,
        _setting_value: { enabled: true },
      }),
      "dealer admin platform setting",
    );
    assertNoError(
      await admin.rpc("admin_set_dealership_setting", {
        _actor_id: adminA.id,
        _dealership_id: dealershipA,
        _setting_key: "dealership.timezone",
        _setting_value: { value: "America/New_York" },
        _read_scope: "active_members",
      }),
      "dealer setting",
    );
    assertDenied(
      await admin.rpc("admin_set_dealership_setting", {
        _actor_id: adminA.id,
        _dealership_id: dealershipB,
        _setting_key: "dealership.timezone",
        _setting_value: { value: "UTC" },
        _read_scope: "active_members",
      }),
      "cross-tenant dealer setting",
    );
    assertDenied(
      await staffAAuth.scoped.from("audit_events").update({ payload: {} }).gte("id", 0),
      "audit update",
    );
    assertDenied(await admin.from("audit_events").delete().gte("id", 0), "service audit delete");
    const audit = assertNoError(
      await admin.from("audit_events").select("event_type,payload").like("event_type", "user.%"),
      "audit read",
    );
    const serialized = JSON.stringify(audit);
    for (const secret of [temporary.password, staffA.password, owner.password])
      assert.equal(serialized.includes(secret), false);
  });

  await check("hosted Storage tenant paths and public reads", async () => {
    const ownPath = `${dealershipA}/${runId}.txt`;
    const crossPath = `${dealershipB}/${runId}.txt`;
    assertNoError(
      await staffAAuth.scoped.storage.from("documents").upload(ownPath, new Blob(["validation"])),
      "own document upload",
    );
    storageObjects.push({ bucket: "documents", path: ownPath });
    assertDenied(
      await staffAAuth.scoped.storage.from("documents").upload(crossPath, new Blob(["cross"])),
      "cross document upload",
    );
    const publicPath = `${dealershipA}/${runId}.txt`;
    assertNoError(
      await staffAAuth.scoped.storage
        .from("overlays")
        .upload(publicPath, new Blob(["public validation"])),
      "overlay upload",
    );
    storageObjects.push({ bucket: "overlays", path: publicPath });
    const anonymous = client(supabaseUrl, publishableKey);
    assertNoError(
      await anonymous.storage.from("overlays").download(publicPath),
      "public overlay read",
    );
  });

  await check("durable hosted queue primitives", async () => {
    const dedupe = `validation-${runId}`;
    const first = assertNoError(
      await admin.rpc("enqueue_background_job", {
        _job_type: "system.noop",
        _payload: { validation_run: runId },
        _dedupe_key: dedupe,
        _max_attempts: 2,
      }),
      "enqueue job",
    );
    const duplicate = assertNoError(
      await admin.rpc("enqueue_background_job", {
        _job_type: "system.noop",
        _payload: { validation_run: runId },
        _dedupe_key: dedupe,
        _max_attempts: 2,
      }),
      "dedupe job",
    );
    assert.equal(first.job_id, duplicate.job_id);
    const claims = await Promise.all([
      admin.rpc("worker_claim_background_job", {
        _worker_id: `validation-${runId}-a`,
        _lease_seconds: 30,
      }),
      admin.rpc("worker_claim_background_job", {
        _worker_id: `validation-${runId}-b`,
        _lease_seconds: 30,
      }),
    ]);
    claims.forEach((result) => assertNoError(result, "concurrent claim"));
    const claimed = claims.map((result) => result.data).filter(Boolean);
    assert.equal(claimed.length, 1);
    const worker = claims[0].data ? `validation-${runId}-a` : `validation-${runId}-b`;
    assertNoError(
      await admin.rpc("worker_heartbeat_background_job", {
        _worker_id: worker,
        _job_id: first.job_id,
        _lease_seconds: 30,
      }),
      "job heartbeat",
    );
    assertNoError(
      await admin.rpc("worker_complete_background_job", {
        _worker_id: worker,
        _job_id: first.job_id,
        _safe_result: { ok: true },
      }),
      "job completion",
    );
    const terminal = assertNoError(
      await admin.rpc("enqueue_background_job", {
        _job_type: "system.noop",
        _payload: { validation_run: runId, terminal: true },
        _dedupe_key: `${dedupe}-terminal`,
        _max_attempts: 1,
      }),
      "enqueue terminal job",
    );
    const terminalClaim = assertNoError(
      await admin.rpc("worker_claim_background_job", {
        _worker_id: `validation-${runId}-terminal`,
        _lease_seconds: 30,
      }),
      "claim terminal job",
    );
    assert.equal(terminalClaim.job_id, terminal.job_id);
    assert.equal(
      assertNoError(
        await admin.rpc("worker_fail_background_job", {
          _worker_id: `validation-${runId}-terminal`,
          _job_id: terminal.job_id,
          _safe_error_code: "validation_terminal",
          _retryable: false,
        }),
        "dead-letter job",
      ),
      "dead_letter",
    );
  });

  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      project_ref: projectRef,
      checks: results.length,
      existing_session_after_admin_password_update: existingSessionAfterReset,
      secrets_printed: false,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(`HOSTED_ACCEPTANCE_FAILED ${safeMessage(error)}\n`);
  process.exitCode = 1;
} finally {
  if (process.env.DEALERSHOT_VALIDATION_KEEP_FIXTURES !== "true") await cleanup();
}
