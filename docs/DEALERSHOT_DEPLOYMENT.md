# DealerShot durable deployment

## Architecture and separation

DealerShot is an independent application deployed directly from
`yhorman17/dealershot` to a dedicated DigitalOcean App Platform app named
`dealershot`.

```text
yhorman17/dealershot
        |
        v
DigitalOcean App Platform: dealershot
        |-- DealerShot web container
        |-- DealerShot-only environment variables and logs
        `-- direct HTTPS custom domain
                    |
                    v
       dealershot.studiogecko.dev

DealerShot browser/server  --->  DealerShot Supabase project
```

`studiogecko.dev` owns only the DNS zone. DealerShot does not run in, proxy
through, import from, or share credentials/data with the `studiogecko.dev` or
`app.studiogecko.dev` applications. The DigitalOcean app must not attach a
DigitalOcean database; its only data services are the independently owned
DealerShot Supabase Database, Auth, and Storage services.

## Hosting decision

DigitalOcean App Platform is the selected host. It supports a dedicated GitHub
deployment, custom domains with managed TLS, deployment history and rollback,
build/deploy/runtime logs, health checks, and separate worker/job components
for the later image pipeline. The container remains portable: the application
builds a Nitro `node-server` artifact and starts it with Node rather than using
a DigitalOcean-specific application API.

Vercel is compatible with TanStack Start through Nitro and offers strong
preview/rollback behavior. It was not selected because DealerShot is a
commercial application (not eligible for Vercel Hobby), and future durable
image workers/queues fit long-running container components more naturally.
Railway is also compatible and is a TanStack hosting partner, but it does not
provide a material advantage over the owner's existing DigitalOcean footprint.

## Runtime contract

| Item                     | Value                                                                          |
| ------------------------ | ------------------------------------------------------------------------------ |
| Build dependency runtime | Bun 1.2.22                                                                     |
| Production runtime       | Node.js 22.18.0 (Alpine image)                                                 |
| Build command            | `bun install --frozen-lockfile && bun run build`                               |
| Build output             | `.output/`                                                                     |
| Server entry point       | `.output/server/index.mjs`                                                     |
| Production start command | `node .output/server/index.mjs` (`npm run start`)                              |
| Nitro preset             | `node-server`                                                                  |
| Host                     | `HOST=0.0.0.0`                                                                 |
| Platform port            | `PORT=8080` in `.do/app.yaml`; Nitro reads the environment variable at runtime |
| Public assets            | Served by the Nitro server from `.output/public`                               |
| Routing                  | TanStack Start SSR/server functions; all application paths reach Nitro         |
| Health check             | `GET /health` returns only `{"status":"ok"}`                                   |

`vite preview` is a preview command, not the production server.

## Environment variables

Configure variables only on the dedicated DealerShot App Platform `web`
component. Do not copy a StudioGecko environment file or credential set.

| Name                            | Scope              | Classification                         | Required                                     | Notes                                                            |
| ------------------------------- | ------------------ | -------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| `VITE_SUPABASE_URL`             | Build time         | Public/browser-safe                    | Yes                                          | DealerShot Supabase URL; compiled into the browser bundle        |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Build time         | Public/browser-safe                    | Yes                                          | DealerShot publishable key; compiled into the browser bundle     |
| `SUPABASE_URL`                  | Runtime            | Server-only configuration, not secret  | Yes                                          | Must identify the same DealerShot project as `VITE_SUPABASE_URL` |
| `SUPABASE_PUBLISHABLE_KEY`      | Runtime            | Server-only configuration, publishable | Yes                                          | Must match the browser publishable key                           |
| `SUPABASE_SERVICE_ROLE_KEY`     | Runtime            | Secret/server-only                     | Yes for owner administration and invitations | Encrypt in App Platform; never use a `VITE_` prefix              |
| `SUPABASE_PROJECT_ID`           | Local/CLI metadata | Public identifier                      | No                                           | Not read by the application                                      |
| `NODE_ENV`                      | Runtime            | Non-secret                             | Yes                                          | `production`                                                     |
| `HOST`                          | Runtime            | Non-secret                             | Yes                                          | `0.0.0.0`                                                        |
| `PORT`                          | Runtime            | Non-secret                             | Yes                                          | `8080`, matching the App Platform component port                 |

The `VITE_*` values must use `RUN_AND_BUILD_TIME` or `BUILD_TIME` scope because
Vite compiles them into the browser bundle. The three unprefixed Supabase
variables must use `RUN_TIME`; mark `SUPABASE_SERVICE_ROLE_KEY` as encrypted.
Never pass the service-role/secret key as a Docker build argument.

Before saving provider values, verify without printing them:

1. Both Supabase URLs contain the same project reference.
2. That reference is the project recorded in `supabase/config.toml`.
3. Both publishable-key variables refer to the same DealerShot publishable key.
4. The service-role/secret key belongs to that same DealerShot project.
5. No value contains a StudioGecko project reference, database host, or key.

Local values stay in ignored `.env`/`.env.local` files. `.env.example` contains
names and placeholders only.

## Initial deployment

The committed app spec deliberately targets `main` for durable automatic
deployments. Do not enable automatic database migrations.

1. Merge the reviewed deployment branch to `main`, or temporarily select the
   reviewed commit/branch in the DigitalOcean control panel for a pre-merge
   deployment.
2. In DigitalOcean, create a **new** App Platform app. Do not select an existing
   StudioGecko app.
3. Connect GitHub repository `yhorman17/dealershot` and the reviewed branch.
4. Confirm the root `Dockerfile` is selected and the service port is `8080`.
5. Add the environment variables above before the first build. Use DealerShot
   values only and encrypt `SUPABASE_SERVICE_ROLE_KEY`.
6. Use `basic-xxs` initially; move to `basic-xs` if runtime memory metrics or
   image-related traffic show pressure.
7. Deploy. The build must complete the frozen Bun install and Nitro Node build.
8. Verify the generated `*.ondigitalocean.app` starter URL, `/health`, `/login`,
   and the protected-route redirect before adding the custom domain.
9. After acceptance, track `main` with deploy-on-push enabled. Database
   migrations remain a separate, reviewed, explicit workflow.

## Custom domain, DNS, and HTTPS

Add `dealershot.studiogecko.dev` to the dedicated DealerShot App Platform app
using **You manage your domain**. DigitalOcean will display the authoritative
CNAME alias ending in `ondigitalocean.app`.

The committed app spec declares that hostname as the primary domain with a
minimum TLS version of 1.2. It intentionally omits `zone`, so App Platform does
not manage or modify any other `studiogecko.dev` DNS record.

Before the DNS write, state and verify this one-record change:

```text
Type:   CNAME
Name:   dealershot
Target: <the exact DigitalOcean alias shown for the DealerShot app>
TTL:    Auto (or 300 seconds during cutover)
Proxy:  DNS-only during certificate validation if the DNS provider offers proxying
```

Do not guess the target and do not point the record at `studiogecko.dev`,
`app.studiogecko.dev`, a local/tunnel hostname, or an unrelated DigitalOcean
app. Do not modify root, `www`, `app`, MX, email, or unrelated records.

DigitalOcean automatically provisions the certificate after DNS validation.
Verify all of the following before announcing the domain:

```sh
curl -I http://dealershot.studiogecko.dev/
curl -I https://dealershot.studiogecko.dev/
curl -fsS https://dealershot.studiogecko.dev/health
```

HTTP must redirect to HTTPS, the certificate must cover the exact hostname,
and all application/static/Supabase requests must use HTTPS. If the zone has
CAA records, allow both `letsencrypt.org` and `pki.goog`, as required by App
Platform.

## Supabase Auth URL configuration

Make changes only after the Supabase project reference is confirmed as the
DealerShot project. In Authentication -> URL Configuration set:

```text
Site URL
https://dealershot.studiogecko.dev

Additional Redirect URLs
https://dealershot.studiogecko.dev/reset-password
https://dealershot.studiogecko.dev/accept-invite
http://localhost:5173/reset-password
http://localhost:5173/accept-invite
```

Use exact production paths rather than a production wildcard. Retain any other
reviewed localhost redirects that are still in active use. Password reset and
invitation code derives the origin from the current DealerShot page, so there
is no dependency on a StudioGecko application URL.

If customized Supabase email templates use `{{ .SiteURL }}` when the code sends
`redirectTo`, review whether they should instead use `{{ .RedirectTo }}`.
Invitation acceptance requires `SUPABASE_SERVICE_ROLE_KEY` only in the trusted
server container; it must never reach the browser.

## Logs, health, and rollback

- Activity shows the commit and deployment timeline.
- Build and deploy logs are retained by App Platform for 90 days.
- Runtime and crash logs are available in the app; configure a log destination
  before longer retention is required.
- `/health` proves only that the application server is accepting requests. It
  intentionally exposes no database status, environment, host, or commit data.

To roll back, open the DealerShot app's Activity page, choose the last verified
deployment, and use **Rollback**. Validate `/health`, `/login`, and the protected
route after traffic moves. A rollback changes only the DealerShot deployment;
it must not alter Supabase migrations or StudioGecko resources.

Emergency disable options, in preferred order:

1. Roll back to the last verified DealerShot deployment.
2. Disable deploy-on-push while investigating.
3. Scale or stop only the DealerShot service if immediate isolation is needed.
4. Remove only the `dealershot` CNAME after the app is intentionally disabled.

## External smoke test

Use the deployed hostname, not localhost:

1. `GET /health` returns HTTP 200 and exactly `{"status":"ok"}`.
2. `/` and `/login` render; a protected dashboard route sends an unauthenticated
   user to `/login`.
3. Static CSS, JavaScript, fonts, and WASM assets return HTTPS 200 responses.
4. At desktop and mobile widths, login and protected-route behavior remain
   usable without horizontal overflow.
5. With a designated non-production tester, sign in, sign out, and confirm the
   session is cleared.
6. Confirm inventory and one vehicle detail page are tenant-scoped.
7. If approved staging data exists, perform one non-destructive photo load/edit
   flow without deleting, publishing, or overwriting source assets.
8. Confirm browser network requests go only to the DealerShot host, the
   DealerShot Supabase project, and intentional third-party asset/API hosts.
9. Shut down any local DealerShot/tunnel process and repeat `/health` and `/login`.

Never create a public admin user, weaken RLS, or add a JavaScript shared-password
gate for testing. DealerShot Supabase Auth remains the access control system.

## Local development

```sh
npx bun@1.2.22 install --frozen-lockfile
npm run dev
```

Local development requires only an ignored local env file; it does not require
a public tunnel. To exercise the production artifact locally:

```sh
npm run build
HOST=0.0.0.0 PORT=3000 npm run start
```

On PowerShell, set `$env:HOST` and `$env:PORT` before `npm.cmd run start`.

## Future move to app.dealershot.com

No repository, database, Supabase project, Storage bucket, Auth user, or
application migration is required:

1. Add `app.dealershot.com` to the existing DealerShot App Platform app.
2. Create its provider-recommended DNS record pointing directly to that app.
3. Add exact Supabase redirect URLs for `/reset-password` and `/accept-invite`.
4. After verification, change the Supabase Site URL to
   `https://app.dealershot.com`.
5. Verify callbacks, CORS (if introduced later), HTTPS, assets, Auth, and logout.
6. Optionally redirect the old DealerShot hostname to the new hostname at the
   hosting ingress layer.
7. Remove the old redirect allowlist entries and `dealershot` DNS record only
   after the migration window ends.

The application already derives browser Auth redirects from its current origin;
the move is a hosting/DNS/Auth-configuration change, not a code or data move.
