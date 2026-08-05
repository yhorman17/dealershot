# DealerShot

DealerShot is a TanStack Start and Supabase application for dealership inventory, vehicle media, exports, and owner administration.

**Live app:** https://dealershot.lovable.app

## Local development

Requirements:

- Node.js and npm, or Bun
- PostgreSQL 17 command-line tools for the disposable authorization suite
- a local environment file populated from approved development credentials

Never place a Supabase service-role key in a `VITE_*` variable or browser code.

```sh
npm install
npm run dev
```

The repository uses `bun.lock`; CI and release work should use a frozen Bun install:

```sh
npx bun install --frozen-lockfile
```

## Verification

```sh
npm run lint
npm run typecheck
npm run build
npm run test:security
npm run verify
```

On Windows, `test:security` starts an isolated PostgreSQL cluster under the system temporary directory, applies the complete migration chain, exercises the real RLS/privilege expressions, then stops and removes the cluster. It defaults to `C:\Program Files\PostgreSQL\17\bin`; pass `-PostgresBin` directly to `scripts/test-security-policies.ps1` if PostgreSQL is installed elsewhere.

The portable compatibility bootstrap models the Supabase `auth` and `storage` objects required by checked-in migrations. It exercises PostgreSQL grants, RLS policies, function privileges, and SQL invitation behavior, but it does not reproduce hosted Auth JWT issuance/refresh, PostgREST request translation, Storage API path normalization, bucket HTTP delivery, or Supabase service internals. For release qualification, also apply the migrations and run native Auth, Data API, and Storage checks in a disposable linked project. Never point the suite at production.

## Authorization model

- An active `owner` is a platform administrator and may access every dealership.
- An active `dealer_admin` or `staff` user is limited to their assigned dealership.
- Dealer access requires dealership status `active` or `trial` and `subscription_status = active`.
- A deactivated profile or suspended/inactive dealership is denied by database and Storage write policies even while its Auth session remains valid.
- Browser clients may update only `profiles.full_name` directly. Role, dealership, account status, and dealership status/subscription fields are protected.
- Owner user-management actions run through authenticated TanStack server functions, revalidate an active owner on the server, and use the server-only Supabase administrative client.
- Invitation acceptance may assign only `staff` or `dealer_admin`, only to a pristine placeholder profile, and only for an active dealership.

Authorization helpers live in a non-exposed `private` database schema, derive identity from `auth.uid()`, use locked search paths, and are consumed by RLS. Public media reads remain compatible with the existing application; active tenant membership is required for writes. Moving originals and work files to a fully private asset model is deferred to the durable image-pipeline phase.

See [the authorization model and disposable validation checklist](docs/DEALERSHOT_AUTHORIZATION.md), [the baseline audit](docs/DEALERSHOT_BASELINE_AUDIT.md), and [controlled roadmap](docs/DEALERSHOT_ROADMAP.md).

## Database changes

Database changes are version-controlled under `supabase/migrations`. Review and validate migrations in a disposable environment before applying them through the normal Supabase deployment workflow. Do not edit production data manually.

## Lovable

This project was built with [Lovable](https://lovable.dev). Continue development in the [Lovable editor](https://lovable.dev/projects/ce5eb0f1-0578-4e12-949c-cdcf98b881cb); reviewed changes pushed to `main` synchronize back to Lovable.
