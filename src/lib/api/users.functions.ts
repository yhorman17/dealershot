import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveUserAccountUpdate } from "@/lib/api/user-account-policy";
import { generateTemporaryPassword } from "@/lib/api/temporary-credentials.server";
import type { Json } from "@/integrations/supabase/types";
import { getApplicationOrigin } from "@/lib/api/application-origin.server";

type ManagedRole = "dealer_admin" | "staff";
const staffAccessRoleSchema = z.enum([
  "store_manager",
  "photographer",
  "inventory_media",
  "accounting",
]);
type ActorScope = { role: "owner" | "dealer_admin"; dealershipIds: string[] };
type OperationResult = {
  operation_id?: string;
  status?: string;
  target_profile_id?: string | null;
};

const dealershipIdsSchema = z.array(z.string().uuid()).min(1).max(100);
const provisionInput = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  full_name: z.string().trim().min(1).max(120),
  role: z.enum(["dealer_admin", "staff"]),
  dealership_ids: dealershipIdsSchema,
  idempotency_key: z.string().uuid(),
});

function asOperationResult(value: unknown): OperationResult {
  return value && typeof value === "object" ? (value as OperationResult) : {};
}

function safeErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/already|registered|exists|duplicate/i.test(message)) return "duplicate_email";
  if (/timeout|fetch|network|connection/i.test(message)) return "transport_uncertain";
  return "provider_error";
}

async function getActorScope(actorId: string): Promise<ActorScope> {
  const [{ data: profile, error: profileError }, { data: onboarding, error: onboardingError }] =
    await Promise.all([
      supabaseAdmin.from("profiles").select("role, status").eq("id", actorId).maybeSingle(),
      supabaseAdmin
        .from("user_onboarding")
        .select("onboarding_state, password_change_required")
        .eq("profile_id", actorId)
        .maybeSingle(),
    ]);
  if (profileError) throw new Error(profileError.message);
  if (onboardingError) throw new Error(onboardingError.message);
  if (
    !profile ||
    profile.status !== "active" ||
    !onboarding ||
    onboarding.onboarding_state !== "complete" ||
    onboarding.password_change_required
  ) {
    throw new Error("Forbidden");
  }
  if (profile.role === "owner") return { role: "owner", dealershipIds: [] };
  if (profile.role !== "dealer_admin") throw new Error("Forbidden");

  const { data, error } = await supabaseAdmin
    .from("profile_dealerships")
    .select("dealership_id, dealerships!inner(status, subscription_status)")
    .eq("profile_id", actorId)
    .in("dealerships.status", ["active", "trial"])
    .eq("dealerships.subscription_status", "active");
  if (error) throw new Error(error.message);
  const dealershipIds = (data ?? []).map((row) => row.dealership_id);
  if (dealershipIds.length === 0) throw new Error("Forbidden");
  return { role: "dealer_admin", dealershipIds };
}

function assertRequestedScope(scope: ActorScope, role: ManagedRole, dealershipIds: string[]) {
  const uniqueIds = [...new Set(dealershipIds)];
  if (uniqueIds.length !== dealershipIds.length) {
    throw new Error("Duplicate dealership assignments are not allowed.");
  }
  if (role === "staff" && uniqueIds.length !== 1) {
    throw new Error("Staff accounts must belong to exactly one dealership.");
  }
  if (
    scope.role === "dealer_admin" &&
    (role !== "staff" || uniqueIds.length !== 1 || !scope.dealershipIds.includes(uniqueIds[0]))
  ) {
    throw new Error("Forbidden");
  }
}

async function markOperation(
  actorId: string,
  operationId: string,
  status: string,
  targetProfileId: string | null = null,
  errorCode: string | null = null,
) {
  const { error } = await supabaseAdmin.rpc("mark_user_account_operation", {
    _actor_id: actorId,
    _operation_id: operationId,
    _status: status,
    _target_profile_id: targetProfileId ?? undefined,
    _safe_error_code: errorCode ?? undefined,
  });
  if (error) throw new Error(error.message);
}

async function readOperation(actorId: string, operationId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_account_operations")
    .select("id, status, target_profile_id")
    .eq("id", operationId)
    .eq("actor_profile_id", actorId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function writeAuditEvent(event: {
  event_type: string;
  actor_profile_id: string;
  dealership_id?: string | null;
  request_id?: string | null;
  payload?: Json;
}) {
  const { error } = await supabaseAdmin.from("audit_events").insert(event);
  if (error) throw new Error(`Audit event could not be recorded: ${error.message}`);
}

async function reconcileProvisioning(actorId: string, operationId: string, authUserId: string) {
  let operation = await readOperation(actorId, operationId);
  if (operation?.status === "complete" && operation.target_profile_id === authUserId) return true;

  if (!operation?.target_profile_id) {
    await markOperation(actorId, operationId, "auth_updated", authUserId).catch(() => undefined);
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { error } = await supabaseAdmin.rpc("finalize_user_provisioning_operation", {
      _actor_id: actorId,
      _operation_id: operationId,
      _auth_user_id: authUserId,
    });
    if (!error) return true;
    operation = await readOperation(actorId, operationId);
    if (operation?.status === "complete" && operation.target_profile_id === authUserId) return true;
  }
  return false;
}

export const listUsersWithAuth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const scope = await getActorScope(context.userId);
    let profileQuery = supabaseAdmin
      .from("profiles")
      .select(
        "id, email, full_name, role, dealership_id, status, created_at, profile_dealerships(dealership_id, access_role, payout_eligible)",
      )
      .order("created_at", { ascending: false });
    // Dealer administrators manage staff by the staff account's authoritative
    // primary dealership. A stale secondary assignment must never widen this
    // directory or disclose an unrelated tenant's account.
    if (scope.role === "dealer_admin") {
      profileQuery = profileQuery.in("dealership_id", scope.dealershipIds).eq("role", "staff");
    }
    const { data: profiles, error: profileError } = await profileQuery;
    if (profileError) throw new Error(profileError.message);

    const ids = (profiles ?? []).map((profile) => profile.id);
    const onboardingMap = new Map<string, boolean>();
    if (ids.length) {
      const { data, error } = await supabaseAdmin
        .from("user_onboarding")
        .select("profile_id, password_change_required")
        .in("profile_id", ids);
      if (error) throw new Error(error.message);
      for (const row of data ?? []) onboardingMap.set(row.profile_id, row.password_change_required);
    }

    const wantedIds = new Set(ids);
    const authMap = new Map<string, string | null>();
    let page = 1;
    while (wantedIds.size > 0 && page <= 25) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new Error(error.message);
      for (const user of data.users) {
        if (wantedIds.has(user.id)) {
          authMap.set(user.id, user.last_sign_in_at ?? null);
          wantedIds.delete(user.id);
        }
      }
      if (data.users.length < 200) break;
      page += 1;
    }

    return (profiles ?? []).map((profile) => {
      const { profile_dealerships: assignments, ...userProfile } = profile;
      const assignedIds = assignments.map((assignment) => assignment.dealership_id);
      const dealershipIds = profile.dealership_id
        ? [profile.dealership_id, ...assignedIds.filter((id) => id !== profile.dealership_id)]
        : assignedIds;
      return {
        ...userProfile,
        dealership_ids: dealershipIds,
        access_role:
          assignments.find((assignment) => assignment.dealership_id === profile.dealership_id)
            ?.access_role ?? (profile.role === "staff" ? "photographer" : null),
        payout_eligible:
          assignments.find((assignment) => assignment.dealership_id === profile.dealership_id)
            ?.payout_eligible ?? false,
        last_sign_in_at: authMap.get(profile.id) ?? null,
        password_change_required: onboardingMap.get(profile.id) ?? false,
      };
    });
  });

export const listUserInvitations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const scope = await getActorScope(context.userId);
    let query = supabaseAdmin
      .from("user_invitations")
      .select(
        "id, email, full_name, role, dealership_id, invited_at, expires_at, accepted_at, status",
      )
      .order("invited_at", { ascending: false });
    if (scope.role === "dealer_admin") {
      query = query.in("dealership_id", scope.dealershipIds).eq("role", "staff");
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const createInvitationAcceptanceLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ invitation_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const scope = await getActorScope(context.userId);
    const { data: invitation, error } = await supabaseAdmin
      .from("user_invitations")
      .select("id, email, full_name, role, dealership_id, token, status, expires_at")
      .eq("id", data.invitation_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (
      !invitation ||
      invitation.status !== "pending" ||
      !invitation.dealership_id ||
      new Date(invitation.expires_at).getTime() <= Date.now()
    ) {
      throw new Error("Invitation is unavailable.");
    }
    assertRequestedScope(scope, invitation.role as ManagedRole, [invitation.dealership_id]);

    const redirectTo = `${getApplicationOrigin()}/accept-invite?token=${encodeURIComponent(invitation.token)}`;
    const { data: generated, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: "invite",
      email: invitation.email,
      options: {
        redirectTo,
        data: {
          full_name: invitation.full_name,
          invitation_token: invitation.token,
        },
      },
    });
    if (linkError || !generated.properties?.action_link) {
      throw new Error("A secure invitation link could not be generated.");
    }
    await writeAuditEvent({
      event_type: "user.invitation_link_generated",
      actor_profile_id: context.userId,
      dealership_id: invitation.dealership_id,
      request_id: invitation.id,
      payload: { role: invitation.role },
    });
    return { url: generated.properties.action_link };
  });

export const inviteUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        email: z.string().trim().toLowerCase().email().max(255),
        full_name: z.string().trim().min(1).max(120),
        role: z.enum(["dealer_admin", "staff"]),
        dealership_id: z.string().uuid(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const scope = await getActorScope(context.userId);
    assertRequestedScope(scope, data.role, [data.dealership_id]);

    const { data: existing, error: existingError } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .ilike("email", data.email)
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);
    if (existing) throw new Error("A user with that email already exists.");

    const token = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const { data: invitation, error: invitationError } = await supabaseAdmin
      .from("user_invitations")
      .insert({
        email: data.email,
        full_name: data.full_name,
        role: data.role,
        dealership_id: data.dealership_id,
        invited_by: context.userId,
        token,
      })
      .select("*")
      .single();
    if (invitationError) throw new Error(invitationError.message);

    const redirectTo = `${getApplicationOrigin()}/accept-invite?token=${encodeURIComponent(token)}`;
    const { error: mailError } = await supabaseAdmin.auth.admin.inviteUserByEmail(data.email, {
      redirectTo,
      data: { full_name: data.full_name, invitation_token: token },
    });
    if (mailError) {
      // A timeout or provider error may arrive after GoTrue created the Auth
      // identity. Keep the durable invitation so the link can be copied or
      // resent instead of creating an orphaned, unrecoverable placeholder.
      await writeAuditEvent({
        event_type: "user.invitation_delivery_unconfirmed",
        actor_profile_id: context.userId,
        dealership_id: data.dealership_id,
        request_id: invitation.id,
        payload: { role: data.role },
      });
      return { invitation, delivery: "unconfirmed" as const };
    }
    await writeAuditEvent({
      event_type: "user.invitation_sent",
      actor_profile_id: context.userId,
      dealership_id: data.dealership_id,
      request_id: invitation.id,
      payload: { role: data.role },
    });
    return { invitation, delivery: "sent" as const };
  });

export const resendInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ invitation_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const scope = await getActorScope(context.userId);
    const { data: invitation, error } = await supabaseAdmin
      .from("user_invitations")
      .select("*")
      .eq("id", data.invitation_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!invitation || invitation.status !== "pending" || !invitation.dealership_id) {
      throw new Error("Invitation is unavailable.");
    }
    assertRequestedScope(scope, invitation.role as ManagedRole, [invitation.dealership_id]);

    const redirectTo = `${getApplicationOrigin()}/accept-invite?token=${encodeURIComponent(invitation.token)}`;
    const { error: mailError } = await supabaseAdmin.auth.admin.inviteUserByEmail(
      invitation.email,
      { redirectTo, data: { full_name: invitation.full_name, invitation_token: invitation.token } },
    );
    if (mailError) throw new Error(`Could not resend invite email: ${mailError.message}`);
    const { error: updateError } = await supabaseAdmin
      .from("user_invitations")
      .update({
        expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
        invited_at: new Date().toISOString(),
      })
      .eq("id", invitation.id);
    if (updateError) throw new Error(updateError.message);
    await writeAuditEvent({
      event_type: "user.invitation_resent",
      actor_profile_id: context.userId,
      dealership_id: invitation.dealership_id,
      request_id: invitation.id,
      payload: { role: invitation.role },
    });
    return { ok: true };
  });

export const revokeInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ invitation_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const scope = await getActorScope(context.userId);
    const { data: invitation, error } = await supabaseAdmin
      .from("user_invitations")
      .select("id, role, dealership_id, status")
      .eq("id", data.invitation_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!invitation || invitation.status !== "pending" || !invitation.dealership_id) {
      throw new Error("Invitation is unavailable.");
    }
    assertRequestedScope(scope, invitation.role as ManagedRole, [invitation.dealership_id]);
    const { error: updateError } = await supabaseAdmin
      .from("user_invitations")
      .update({ status: "revoked" })
      .eq("id", invitation.id);
    if (updateError) throw new Error(updateError.message);
    await writeAuditEvent({
      event_type: "user.invitation_revoked",
      actor_profile_id: context.userId,
      dealership_id: invitation.dealership_id,
      request_id: invitation.id,
    });
    return { ok: true };
  });

export const provisionUserWithTemporaryPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => provisionInput.parse(input))
  .handler(async ({ data, context }) => {
    const scope = await getActorScope(context.userId);
    assertRequestedScope(scope, data.role, data.dealership_ids);
    const { data: beginData, error: beginError } = await supabaseAdmin.rpc(
      "begin_user_provisioning_operation",
      {
        _actor_id: context.userId,
        _idempotency_key: data.idempotency_key,
        _email: data.email,
        _full_name: data.full_name,
        _role: data.role,
        _dealership_ids: data.dealership_ids,
      },
    );
    if (beginError) throw new Error(beginError.message);
    const operation = asOperationResult(beginData);
    if (!operation.operation_id) throw new Error("Provisioning operation was not created.");
    if (operation.status !== "requested") {
      return { status: operation.status, operation_id: operation.operation_id, credentials: null };
    }

    const password = generateTemporaryPassword();
    await markOperation(context.userId, operation.operation_id, "auth_pending");
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password,
      email_confirm: true,
      user_metadata: { full_name: data.full_name },
    });
    if (authError || !authData.user) {
      const code = safeErrorCode(authError ?? new Error("Auth user was not returned."));
      await markOperation(
        context.userId,
        operation.operation_id,
        code === "duplicate_email" ? "failed" : "needs_reconciliation",
        null,
        code,
      ).catch(() => undefined);
      throw new Error(
        code === "duplicate_email"
          ? "A user with that email already exists."
          : "Account creation needs reconciliation before it can be retried.",
      );
    }

    const reconciled = await reconcileProvisioning(
      context.userId,
      operation.operation_id,
      authData.user.id,
    );
    if (!reconciled) {
      await markOperation(
        context.userId,
        operation.operation_id,
        "needs_reconciliation",
        authData.user.id,
        "database_finalize_uncertain",
      ).catch(() => undefined);
      throw new Error(
        "The Auth account exists, but access setup needs administrator reconciliation.",
      );
    }

    return {
      status: "complete",
      operation_id: operation.operation_id,
      credentials: {
        email: data.email,
        temporary_password: password,
        login_url: `${getApplicationOrigin()}/login`,
        requires_password_change: true,
      },
    };
  });

export const resetTemporaryPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ user_id: z.string().uuid(), idempotency_key: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await getActorScope(context.userId);
    const { data: beginData, error: beginError } = await supabaseAdmin.rpc(
      "begin_temporary_password_reset_operation",
      {
        _actor_id: context.userId,
        _idempotency_key: data.idempotency_key,
        _target_profile_id: data.user_id,
      },
    );
    if (beginError) throw new Error(beginError.message);
    const operation = asOperationResult(beginData);
    if (!operation.operation_id) throw new Error("Password reset operation was not created.");
    if (operation.status !== "requested") {
      return { status: operation.status, operation_id: operation.operation_id, credentials: null };
    }

    const password = generateTemporaryPassword();
    await markOperation(context.userId, operation.operation_id, "auth_pending", data.user_id);
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.updateUserById(
      data.user_id,
      { password },
    );
    if (authError || !authData.user || authData.user.id !== data.user_id) {
      const code = safeErrorCode(authError ?? new Error("Auth user was not returned."));
      if (code === "transport_uncertain") {
        const { error: containmentError } = await supabaseAdmin.rpc(
          "contain_temporary_password_reset_operation",
          {
            _actor_id: context.userId,
            _operation_id: operation.operation_id,
            _safe_error_code: code,
          },
        );
        if (containmentError) {
          throw new Error(
            "The password reset result is uncertain and access containment failed. Reconciliation is required immediately.",
          );
        }
        throw new Error(
          "The password reset result is uncertain. The account was contained and requires reconciliation.",
        );
      }
      await markOperation(
        context.userId,
        operation.operation_id,
        "failed",
        data.user_id,
        code,
      ).catch(() => undefined);
      throw new Error(
        "The temporary password could not be reset. Account access remains contained; issue a fresh reset after resolving the provider error.",
      );
    }
    try {
      await markOperation(context.userId, operation.operation_id, "auth_updated", data.user_id);
    } catch {
      const { error: containmentError } = await supabaseAdmin.rpc(
        "contain_temporary_password_reset_operation",
        {
          _actor_id: context.userId,
          _operation_id: operation.operation_id,
          _safe_error_code: "operation_mark_uncertain",
        },
      );
      if (containmentError) {
        throw new Error(
          "The password changed, but operation reconciliation failed. Operator action is required.",
        );
      }
      throw new Error("The password changed, but a fresh administrator reset is required.");
    }
    const { error: finalizeError } = await supabaseAdmin.rpc(
      "finalize_temporary_password_reset_operation",
      { _actor_id: context.userId, _operation_id: operation.operation_id },
    );
    if (finalizeError) {
      const current = await readOperation(context.userId, operation.operation_id);
      if (current?.status !== "complete") {
        const { error: containmentError } = await supabaseAdmin.rpc(
          "contain_temporary_password_reset_operation",
          {
            _actor_id: context.userId,
            _operation_id: operation.operation_id,
            _safe_error_code: "database_finalize_uncertain",
          },
        );
        if (containmentError) {
          throw new Error(
            "The password changed, but access containment failed. Reconciliation is required immediately.",
          );
        }
        throw new Error("The password changed, but onboarding containment needs reconciliation.");
      }
    }

    return {
      status: "complete",
      operation_id: operation.operation_id,
      credentials: {
        email: authData.user.email ?? "",
        temporary_password: password,
        login_url: `${getApplicationOrigin()}/login`,
        requires_password_change: true,
      },
    };
  });

export const completeTemporaryPasswordChange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        password: z
          .string()
          .min(12)
          .max(128)
          .regex(/[A-Z]/, "Include an uppercase letter.")
          .regex(/[a-z]/, "Include a lowercase letter.")
          .regex(/[0-9]/, "Include a number.")
          .regex(/[^A-Za-z0-9]/, "Include a symbol."),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: onboarding, error: onboardingError } = await supabaseAdmin
      .from("user_onboarding")
      .select("onboarding_method, onboarding_state, password_change_required")
      .eq("profile_id", context.userId)
      .maybeSingle();
    if (onboardingError) throw new Error(onboardingError.message);
    if (
      !onboarding ||
      onboarding.onboarding_method !== "admin_provisioned" ||
      onboarding.onboarding_state !== "password_change_required" ||
      !onboarding.password_change_required
    ) {
      throw new Error("Password change is not required.");
    }

    // The middleware verifies the caller's bearer token but deliberately does
    // not persist an Auth session. Bind the Admin update to that verified user
    // ID; supabase.auth.updateUser() would fail here with AuthSessionMissingError.
    const { data: authData, error: passwordError } = await supabaseAdmin.auth.admin.updateUserById(
      context.userId,
      {
        password: data.password,
      },
    );
    if (passwordError || !authData.user || authData.user.id !== context.userId) {
      throw new Error("Password could not be updated.");
    }
    const { error } = await supabaseAdmin.rpc("complete_temporary_password_onboarding", {
      _actor_id: context.userId,
    });
    if (error) {
      throw new Error(
        "The password changed, but account setup did not complete. Submit a different new password to finish securely.",
      );
    }
    return { ok: true };
  });

export const updateUserAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        user_id: z.string().uuid(),
        full_name: z.string().trim().min(1).max(120),
        role: z.enum(["dealer_admin", "staff"]).optional(),
        dealership_ids: dealershipIdsSchema,
        access_role: staffAccessRoleSchema.optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await getActorScope(context.userId);
    const { data: target, error: targetError } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("id", data.user_id)
      .maybeSingle();
    if (targetError) throw new Error(targetError.message);
    if (!target) throw new Error("User not found");
    const accountUpdate = resolveUserAccountUpdate({
      targetRole: target.role,
      requestedRole: data.role,
      requestedDealershipIds: data.dealership_ids,
    });
    const { error } = await supabaseAdmin.rpc("admin_update_user_account_access", {
      _actor_user_id: context.userId,
      _target_user_id: data.user_id,
      _full_name: data.full_name,
      _role: accountUpdate.role,
      _dealership_ids: accountUpdate.dealershipIds,
    });
    if (error) throw new Error(error.message);
    if (accountUpdate.role === "staff") {
      const { error: assignmentError } = await supabaseAdmin
        .from("profile_dealerships")
        .update({
          access_role: data.access_role ?? "photographer",
          payout_eligible: (data.access_role ?? "photographer") === "photographer",
        })
        .eq("profile_id", data.user_id)
        .eq("dealership_id", accountUpdate.dealershipIds[0]);
      if (assignmentError) throw new Error(assignmentError.message);
      await writeAuditEvent({
        event_type: "user.store_access_role_changed",
        actor_profile_id: context.userId,
        dealership_id: accountUpdate.dealershipIds[0],
        payload: {
          target_profile_id: data.user_id,
          access_role: data.access_role ?? "photographer",
        },
      });
    }
    return { ok: true };
  });

export const setUserActivation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({ user_id: z.string().uuid(), status: z.enum(["active", "deactivated"]) })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await getActorScope(context.userId);
    const { error } = await supabaseAdmin.rpc("admin_set_user_activation", {
      _actor_id: context.userId,
      _target_profile_id: data.user_id,
      _status: data.status,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
