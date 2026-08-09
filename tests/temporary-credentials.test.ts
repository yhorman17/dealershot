import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  generateTemporaryPassword,
  isValidTemporaryPassword,
} from "../src/lib/api/temporary-credentials.server.ts";

test("temporary passwords are cryptographically generated with every required class", () => {
  const generated = new Set<string>();
  for (let index = 0; index < 250; index++) {
    const password = generateTemporaryPassword();
    assert.equal(password.length, 20);
    assert.equal(isValidTemporaryPassword(password), true);
    generated.add(password);
  }
  assert.equal(generated.size, 250);
});

test("temporary password generator rejects undersized output", () => {
  assert.throws(() => generateTemporaryPassword(15), /between 16 and 128/);
});

test("credentials are not persisted or logged by the application workflow", () => {
  const root = process.cwd();
  const server = readFileSync(path.join(root, "src/lib/api/users.functions.ts"), "utf8");
  const migration = readFileSync(
    path.join(root, "supabase/migrations/20260809201651_admin_provisioned_user_accounts.sql"),
    "utf8",
  );
  assert.doesNotMatch(server, /console\.(?:log|info|warn|error)\([^\n]*password/i);
  assert.doesNotMatch(migration, /temporary_password\s+(?:text|varchar|character)/i);
  assert.doesNotMatch(migration, /password_hash|credential_secret/i);
});

test("privileged middleware verifies the token against Supabase Auth", () => {
  const middleware = readFileSync(
    path.join(process.cwd(), "src/integrations/supabase/auth-middleware.ts"),
    "utf8",
  );
  assert.match(middleware, /auth\.getUser\(token\)/);
  assert.doesNotMatch(middleware, /auth\.getClaims\(token\)/);
});

test("forced password completion binds the Admin Auth update to the verified caller", () => {
  const server = readFileSync(path.join(process.cwd(), "src/lib/api/users.functions.ts"), "utf8");
  const route = readFileSync(path.join(process.cwd(), "src/routes/change-password.tsx"), "utf8");
  assert.match(server, /auth\.admin\.updateUserById\(\s*context\.userId/);
  assert.doesNotMatch(server, /context\.supabase\.auth\.updateUser\(/);
  assert.match(server, /onboarding_method\s*!==\s*"admin_provisioned"/);
  assert.match(route, /auth\.signInWithPassword\(\{ email, password \}\)/);
  assert.match(route, /auth\.signOut\(\{ scope: "local" \}\)/);
});

test("administrator reset containment precedes the hosted Auth password update", () => {
  const migration = readFileSync(
    path.join(
      process.cwd(),
      "supabase/migrations/20260809220000_harden_hosted_password_lifecycle.sql",
    ),
    "utf8",
  );
  const containment = migration.indexOf("UPDATE public.user_onboarding");
  const returnedOperation = migration.indexOf(
    "RETURN jsonb_build_object('operation_id', operation_id, 'status', 'requested')",
  );
  assert.ok(containment >= 0);
  assert.ok(returnedOperation > containment);
  assert.match(migration, /user_account_operations_active_reset_target_idx/);
});

test("invitation redirects do not trust a browser-supplied origin", () => {
  const server = readFileSync(path.join(process.cwd(), "src/lib/api/users.functions.ts"), "utf8");
  const invite = readFileSync(
    path.join(process.cwd(), "src/components/InviteUserModal.tsx"),
    "utf8",
  );
  const users = readFileSync(
    path.join(process.cwd(), "src/routes/_authenticated/users.tsx"),
    "utf8",
  );
  assert.match(server, /getApplicationOrigin\(\)/);
  assert.match(server, /invitation_delivery_unconfirmed/);
  assert.match(server, /auth\.admin\.generateLink\(\{/);
  assert.match(server, /properties\?\.action_link/);
  assert.match(server, /invitation_link_generated/);
  assert.doesNotMatch(server, /from\("user_invitations"\)\.delete\(\)/);
  assert.doesNotMatch(server, /origin:\s*z\.string/);
  assert.doesNotMatch(invite, /window\.location\.origin/);
  assert.doesNotMatch(users, /window\.location\.origin/);
  assert.doesNotMatch(server, /from\("user_invitations"\)\.select\("\*"\)\.order\("invited_at"/);
});

test("hosted acceptance keeps protected projects closed unless exactly authorized", () => {
  const harness = readFileSync(path.join(process.cwd(), "scripts/test-hosted-phase1.mjs"), "utf8");
  assert.match(harness, /PROTECTED_PROJECT_CONFIRMATIONS/);
  assert.match(harness, /oyuvdarrkwpqmufzidnc/);
  assert.match(harness, /validate-authorized-dealershot:oyuvdarrkwpqmufzidnc/);
  assert.match(harness, /validate-disposable:/);
  assert.match(harness, /confirmation !== expectedConfirmation/);
  assert.doesNotMatch(
    harness,
    /console\.(?:log|info|warn|error)\([^\n]*(?:serviceRoleKey|publishableKey)/,
  );
});

test("one-time credential handoff exposes every copy target without persisting it", () => {
  const component = readFileSync(
    path.join(process.cwd(), "src/components/TemporaryCredentialsDialogs.tsx"),
    "utf8",
  );
  const server = readFileSync(path.join(process.cwd(), "src/lib/api/users.functions.ts"), "utf8");
  assert.match(component, /aria-label="Copy email"/);
  assert.match(component, /aria-label="Copy temporary password"/);
  assert.match(component, /aria-label="Copy login URL"/);
  assert.match(component, /Copy all credentials/);
  assert.match(server, /login_url: `\$\{getApplicationOrigin\(\)\}\/login`/);
});
