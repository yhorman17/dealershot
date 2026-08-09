import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveUserAccountUpdate } from "@/lib/api/user-account-policy";

type ProfileStatus = "active" | "deactivated";

async function assertActiveOwner(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("role, status")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.role !== "owner" || data.status !== "active") {
    throw new Error("Forbidden");
  }
}

async function assertActiveDealership(dealershipId: string) {
  const { data, error } = await supabaseAdmin
    .from("dealerships")
    .select("id, status, subscription_status")
    .eq("id", dealershipId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (
    !data ||
    !["active", "trial"].includes(data.status) ||
    data.subscription_status !== "active"
  ) {
    throw new Error("The selected dealership is not active.");
  }
}

async function assertActiveDealerships(dealershipIds: string[]) {
  const uniqueIds = [...new Set(dealershipIds)];
  if (uniqueIds.length !== dealershipIds.length) {
    throw new Error("Duplicate dealership assignments are not allowed.");
  }
  const { data, error } = await supabaseAdmin
    .from("dealerships")
    .select("id, status, subscription_status")
    .in("id", uniqueIds);
  if (error) throw new Error(error.message);
  const activeIds = new Set(
    (data ?? [])
      .filter(
        (dealership) =>
          ["active", "trial"].includes(dealership.status) &&
          dealership.subscription_status === "active",
      )
      .map((dealership) => dealership.id),
  );
  if (uniqueIds.length === 0 || uniqueIds.some((id) => !activeIds.has(id))) {
    throw new Error("Every assigned dealership must be active.");
  }
}

async function assertTargetProfile(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id, role, dealership_id, status")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("User not found");
  return data;
}

async function assertProfileHasActiveDealership(
  userId: string,
  role: string,
  primaryDealershipId: string | null,
) {
  let dealershipIds = primaryDealershipId ? [primaryDealershipId] : [];
  if (role === "dealer_admin") {
    const { data, error } = await supabaseAdmin
      .from("profile_dealerships")
      .select("dealership_id")
      .eq("profile_id", userId);
    if (error) throw new Error(error.message);
    dealershipIds = (data ?? []).map((assignment) => assignment.dealership_id);
  }
  if (dealershipIds.length === 0) {
    throw new Error("Assign an active dealership before reactivating this user.");
  }

  const { data, error } = await supabaseAdmin
    .from("dealerships")
    .select("id")
    .in("id", dealershipIds)
    .in("status", ["active", "trial"])
    .eq("subscription_status", "active")
    .limit(1);
  if (error) throw new Error(error.message);
  if (!data?.length) {
    throw new Error("Assign an active dealership before reactivating this user.");
  }
}

export const listUsersWithAuth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertActiveOwner(context.userId);
    const { data: profiles, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select(
        "id, email, full_name, role, dealership_id, status, created_at, profile_dealerships(dealership_id)",
      )
      .order("created_at", { ascending: false });
    if (profileError) throw new Error(profileError.message);

    const authMap = new Map<string, string | null>();
    let page = 1;
    while (true) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({
        page,
        perPage: 200,
      });
      if (error) throw new Error(error.message);
      for (const user of data.users) {
        authMap.set(user.id, user.last_sign_in_at ?? null);
      }
      if (data.users.length < 200) break;
      page++;
      if (page > 25) break;
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
        last_sign_in_at: authMap.get(profile.id) ?? null,
      };
    });
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
        origin: z.string().url(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertActiveOwner(context.userId);
    await assertActiveDealership(data.dealership_id);

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

    const redirectTo = `${data.origin}/accept-invite?token=${encodeURIComponent(token)}`;
    const { error: mailError } = await supabaseAdmin.auth.admin.inviteUserByEmail(data.email, {
      redirectTo,
      data: {
        full_name: data.full_name,
        invitation_token: token,
      },
    });
    if (mailError) {
      const { error: cleanupError } = await supabaseAdmin
        .from("user_invitations")
        .delete()
        .eq("id", invitation.id);
      if (cleanupError) {
        throw new Error(
          `Could not send invite email, and invitation cleanup failed: ${cleanupError.message}`,
        );
      }
      throw new Error(`Could not send invite email: ${mailError.message}`);
    }

    return { invitation, invite_link: redirectTo };
  });

export const resendInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ invitation_id: z.string().uuid(), origin: z.string().url() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertActiveOwner(context.userId);
    const { data: invitation, error } = await supabaseAdmin
      .from("user_invitations")
      .select("*")
      .eq("id", data.invitation_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!invitation) throw new Error("Invitation not found");
    if (invitation.status !== "pending") {
      throw new Error("Invitation is no longer pending");
    }
    if (!["dealer_admin", "staff"].includes(invitation.role) || !invitation.dealership_id) {
      throw new Error("Owner invitations are not supported.");
    }
    await assertActiveDealership(invitation.dealership_id);

    const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { error: updateError } = await supabaseAdmin
      .from("user_invitations")
      .update({
        expires_at: newExpiry,
        invited_at: new Date().toISOString(),
      })
      .eq("id", invitation.id);
    if (updateError) throw new Error(updateError.message);

    const redirectTo = `${data.origin}/accept-invite?token=${encodeURIComponent(invitation.token)}`;
    const { error: mailError } = await supabaseAdmin.auth.admin.inviteUserByEmail(
      invitation.email,
      {
        redirectTo,
        data: {
          full_name: invitation.full_name,
          invitation_token: invitation.token,
        },
      },
    );
    if (mailError) {
      const { error: rollbackError } = await supabaseAdmin
        .from("user_invitations")
        .update({
          expires_at: invitation.expires_at,
          invited_at: invitation.invited_at,
        })
        .eq("id", invitation.id);
      if (rollbackError) {
        throw new Error(
          `Could not resend invite email, and invitation rollback failed: ${rollbackError.message}`,
        );
      }
      throw new Error(`Could not resend invite email: ${mailError.message}`);
    }
    return { ok: true, invite_link: redirectTo };
  });

export const updateUserAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        user_id: z.string().uuid(),
        full_name: z.string().trim().min(1).max(120),
        role: z.enum(["dealer_admin", "staff"]).optional(),
        dealership_ids: z.array(z.string().uuid()).min(1).max(100),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertActiveOwner(context.userId);
    if (data.user_id === context.userId) {
      throw new Error("Use profile settings to change your own name.");
    }
    const target = await assertTargetProfile(data.user_id);
    const accountUpdate = resolveUserAccountUpdate({
      targetRole: target.role,
      requestedRole: data.role,
      requestedDealershipIds: data.dealership_ids,
    });
    await assertActiveDealerships(accountUpdate.dealershipIds);

    const { error } = await supabaseAdmin.rpc("admin_update_user_account_access", {
      _actor_user_id: context.userId,
      _target_user_id: data.user_id,
      _full_name: data.full_name,
      _role: accountUpdate.role,
      _dealership_ids: accountUpdate.dealershipIds,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setUserActivation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        user_id: z.string().uuid(),
        status: z.enum(["active", "deactivated"]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertActiveOwner(context.userId);
    if (data.user_id === context.userId) {
      throw new Error("You cannot deactivate your own account.");
    }
    const target = await assertTargetProfile(data.user_id);
    if (data.status === "active" && target.role !== "owner") {
      await assertProfileHasActiveDealership(data.user_id, target.role, target.dealership_id);
    }

    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ status: data.status as ProfileStatus })
      .eq("id", data.user_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteUserAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ user_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertActiveOwner(context.userId);
    if (data.user_id === context.userId) {
      throw new Error("You cannot remove your own account.");
    }
    await assertTargetProfile(data.user_id);

    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(data.user_id);
    if (authError && !/not found/i.test(authError.message)) {
      throw new Error(authError.message);
    }
    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .delete()
      .eq("id", data.user_id);
    if (profileError) throw new Error(profileError.message);
    return { ok: true };
  });
