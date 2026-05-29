import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

async function assertOwner(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.role !== "owner") throw new Error("Forbidden");
}

// List all users with their auth metadata (last_sign_in_at)
export const listUsersWithAuth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertOwner(context.userId);
    // Pull all profiles
    const { data: profiles, error: pErr } = await supabaseAdmin
      .from("profiles")
      .select("id, email, full_name, role, dealership_id, status, created_at")
      .order("created_at", { ascending: false });
    if (pErr) throw new Error(pErr.message);

    // Pull all auth users (paginated)
    const authMap = new Map<string, string | null>();
    let page = 1;
    while (true) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new Error(error.message);
      for (const u of data.users) authMap.set(u.id, u.last_sign_in_at ?? null);
      if (data.users.length < 200) break;
      page++;
      if (page > 25) break;
    }

    return (profiles ?? []).map((p) => ({
      ...p,
      last_sign_in_at: authMap.get(p.id) ?? null,
    }));
  });

// Invite a user — creates user_invitations row and sends invite email
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
    await assertOwner(context.userId);

    // Block if a profile with this email already exists
    const { data: existing } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .ilike("email", data.email)
      .maybeSingle();
    if (existing) throw new Error("A user with that email already exists.");

    const token = crypto.randomUUID() + "-" + crypto.randomUUID();

    const { data: inv, error: invErr } = await supabaseAdmin
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
    if (invErr) throw new Error(invErr.message);

    const redirectTo = `${data.origin}/accept-invite?token=${encodeURIComponent(token)}`;

    const { error: mailErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(data.email, {
      redirectTo,
      data: { full_name: data.full_name, invitation_token: token },
    });
    if (mailErr) {
      // Roll back invitation row so the owner can retry cleanly
      await supabaseAdmin.from("user_invitations").delete().eq("id", inv.id);
      throw new Error(`Could not send invite email: ${mailErr.message}`);
    }

    return { invitation: inv, invite_link: redirectTo };
  });

export const resendInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ invitation_id: z.string().uuid(), origin: z.string().url() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertOwner(context.userId);
    const { data: inv, error } = await supabaseAdmin
      .from("user_invitations")
      .select("*")
      .eq("id", data.invitation_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!inv) throw new Error("Invitation not found");
    if (inv.status !== "pending") throw new Error("Invitation is no longer pending");

    const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await supabaseAdmin
      .from("user_invitations")
      .update({ expires_at: newExpiry, invited_at: new Date().toISOString() })
      .eq("id", inv.id);

    const redirectTo = `${data.origin}/accept-invite?token=${encodeURIComponent(inv.token)}`;
    const { error: mailErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(inv.email, {
      redirectTo,
      data: { full_name: inv.full_name, invitation_token: inv.token },
    });
    if (mailErr) throw new Error(`Could not resend invite email: ${mailErr.message}`);
    return { ok: true, invite_link: redirectTo };
  });

export const deleteUserAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ user_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertOwner(context.userId);
    if (data.user_id === context.userId) throw new Error("You cannot remove your own account.");
    const { error: aErr } = await supabaseAdmin.auth.admin.deleteUser(data.user_id);
    if (aErr && !/not found/i.test(aErr.message)) throw new Error(aErr.message);
    await supabaseAdmin.from("profiles").delete().eq("id", data.user_id);
    return { ok: true };
  });
