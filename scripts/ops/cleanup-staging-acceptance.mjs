#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

export const TARGET_PROJECT_REF = "oyuvdarrkwpqmufzidnc";
export const TARGET_PROJECT_NAME = "DealerShot";
export const EXECUTION_CONFIRMATION =
  "cleanup-authorized-dealershot:oyuvdarrkwpqmufzidnc:acceptance-fixtures-only";

const SUPABASE_CLI = process.platform === "win32" ? process.execPath : "supabase";
const SUPABASE_CLI_PREFIX =
  process.platform === "win32" && process.env.APPDATA
    ? [join(process.env.APPDATA, "npm", "node_modules", "supabase", "dist", "supabase.js")]
    : [];

export const OWNER_PROFILE_ID = "d7c7ba29-35b9-4fda-a27d-2345da2e0150";
export const RETAINED_STORE_ID = "bacaab56-5196-482e-8e0a-d7044e6fe57f";
export const RETAINED_STORE_NAME = "Rick Case Volkswagen";

export const ACCEPTANCE_ORGANIZATIONS = Object.freeze([
  Object.freeze({
    id: "22434ec8-dba3-41d8-b2e6-7c8738e49378",
    name: "DealerShot Acceptance Store A",
  }),
  Object.freeze({
    id: "1cabf9f5-fbc3-4d9d-bce5-fe8083447f4e",
    name: "DealerShot Acceptance Store B",
  }),
]);

export const ACCEPTANCE_PROFILES = Object.freeze([
  Object.freeze({ id: "596b4fb2-49c0-4210-acae-a0b5c1401c96", name: "Acceptance Dealer Admin" }),
  Object.freeze({ id: "60843408-1c74-4601-a9c3-8700ba84d676", name: "Acceptance Store Manager" }),
  Object.freeze({ id: "1dcc183e-2f41-4213-b3e8-a3f95bb3157a", name: "Acceptance Photographer A" }),
  Object.freeze({ id: "4b9765ab-877b-406e-bda6-ea384355f060", name: "Acceptance Inventory Media" }),
  Object.freeze({ id: "fc019b51-45aa-4220-ad28-4145f2dc7e30", name: "Acceptance Accounting" }),
  Object.freeze({ id: "42bc38fa-b740-4606-aa19-93ae1317ee75", name: "Acceptance Photographer B" }),
]);

function usage() {
  return `DealerShot staging acceptance cleanup

Dry-run (default):
  bun scripts/ops/cleanup-staging-acceptance.mjs \\
    --project-ref ${TARGET_PROJECT_REF} \\
    --manifest <sensitive-backup-directory>/dry-run-manifest.json

Dry-run plus a fully rolled-back database compatibility check:
  bun scripts/ops/cleanup-staging-acceptance.mjs \\
    --project-ref ${TARGET_PROJECT_REF} \\
    --validate-transaction

Execute only after the dry run and logical dump are reviewed:
  bun scripts/ops/cleanup-staging-acceptance.mjs \\
    --project-ref ${TARGET_PROJECT_REF} \\
    --execute \\
    --confirm ${EXECUTION_CONFIRMATION} \\
    --backup-dir <sensitive-backup-directory>

The tool refuses any other project, validates exact fixture IDs and markers,
backs up every targeted Storage object, and never prints credentials.`;
}

export function parseArgs(argv) {
  const options = {
    execute: false,
    projectRef: "",
    confirmation: "",
    backupDir: "",
    manifestPath: "",
    validateTransaction: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") options.execute = true;
    else if (argument === "--validate-transaction") options.validateTransaction = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--project-ref") options.projectRef = argv[++index] ?? "";
    else if (argument === "--confirm") options.confirmation = argv[++index] ?? "";
    else if (argument === "--backup-dir") options.backupDir = argv[++index] ?? "";
    else if (argument === "--manifest") options.manifestPath = argv[++index] ?? "";
    else throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

function safeMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/eyJ[A-Za-z0-9._-]+/g, "[REDACTED_JWT]")
    .replace(/sb_secret_[A-Za-z0-9_-]+/g, "[REDACTED_SECRET]")
    .replace(/(?:postgres(?:ql)?|https?):\/\/\S+/gi, "[REDACTED_URL]")
    .slice(0, 1_000);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status}): ${safeMessage(result.stderr || result.stdout)}`,
    );
  }
  return result.stdout;
}

function supabaseJson(args) {
  const output = run(SUPABASE_CLI, [...SUPABASE_CLI_PREFIX, ...args, "--output", "json"]);
  return JSON.parse(output);
}

function discoverPsql() {
  const candidates = [
    process.env.PSQL_PATH,
    "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe",
    "C:\\Program Files\\PostgreSQL\\17\\pgAdmin 4\\runtime\\psql.exe",
    "psql",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      run(candidate, ["--version"]);
      return candidate;
    } catch {
      // Try the next known installation.
    }
  }
  throw new Error("PostgreSQL 17 psql is required for the atomic cleanup transaction.");
}

function temporaryDatabaseConnection(projectRef) {
  run(SUPABASE_CLI, [...SUPABASE_CLI_PREFIX, "link", "--project-ref", projectRef, "--yes"]);
  const script = run(SUPABASE_CLI, [...SUPABASE_CLI_PREFIX, "db", "dump", "--linked", "--dry-run"]);
  const field = (name) => {
    const match = script.match(new RegExp(`export ${name}=\"([^\"]+)\"`));
    if (!match) throw new Error(`Supabase CLI did not provide ${name}.`);
    return match[1];
  };
  return {
    PGHOST: field("PGHOST"),
    PGPORT: field("PGPORT"),
    PGUSER: field("PGUSER"),
    PGPASSWORD: field("PGPASSWORD"),
    PGDATABASE: field("PGDATABASE"),
  };
}

function psqlQuery(psql, connection, sql) {
  const result = run(
    psql,
    ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "--set", "VERBOSITY=terse"],
    {
      env: { ...process.env, ...connection },
      input: `SET ROLE postgres;\n${sql}\n`,
      maxBuffer: 16 * 1024 * 1024,
    },
  ).trim();
  return result ? JSON.parse(result) : null;
}

function psqlExecute(psql, connection, sql) {
  run(psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "--set", "VERBOSITY=terse"], {
    env: { ...process.env, ...connection },
    input: `SET ROLE postgres;\n${sql}\n`,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function uuidArray(rows) {
  return `ARRAY[${rows.map(({ id }) => `'${id}'::uuid`).join(",")}]`;
}

const organizationIdsSql = uuidArray(ACCEPTANCE_ORGANIZATIONS);
const storeIdsSql = organizationIdsSql;
const profileIdsSql = uuidArray(ACCEPTANCE_PROFILES);

function manifestSql() {
  return `
WITH target_stores AS (
  SELECT * FROM public.dealerships WHERE id = ANY(${storeIdsSql})
), target_organizations AS (
  SELECT * FROM public.organizations WHERE id = ANY(${organizationIdsSql})
), target_profiles AS (
  SELECT * FROM public.profiles WHERE id = ANY(${profileIdsSql})
), target_vehicles AS (
  SELECT * FROM public.vehicles WHERE dealership_id = ANY(${storeIdsSql})
), target_assets AS (
  SELECT * FROM public.media_assets WHERE dealership_id = ANY(${storeIdsSql})
), target_photos AS (
  SELECT p.* FROM public.photos p JOIN target_vehicles v ON v.id = p.vehicle_id
), target_variants AS (
  SELECT mv.* FROM public.media_variants mv JOIN target_assets ma ON ma.id = mv.media_asset_id
), target_sessions AS (
  SELECT * FROM public.photo_capture_sessions WHERE dealership_id = ANY(${storeIdsSql})
), referenced_objects AS (
  SELECT storage_bucket AS bucket_id, storage_object_path AS object_path FROM target_assets
  UNION
  SELECT storage_bucket, storage_path FROM target_variants
  UNION
  SELECT msm.source_bucket, msm.source_path
  FROM private.media_storage_migrations msm JOIN target_assets ma ON ma.id = msm.media_asset_id
  UNION
  SELECT msm.destination_bucket, msm.destination_path
  FROM private.media_storage_migrations msm JOIN target_assets ma ON ma.id = msm.media_asset_id
), matching_objects AS (
  SELECT DISTINCT so.bucket_id, so.name object_path,
    COALESCE((so.metadata->>'size')::bigint, 0) byte_size,
    so.metadata->>'mimetype' content_type
  FROM storage.objects so
  WHERE EXISTS (
    SELECT 1 FROM referenced_objects ro
    WHERE ro.bucket_id = so.bucket_id AND ro.object_path = so.name
  ) OR EXISTS (
    SELECT 1 FROM target_vehicles v WHERE so.name LIKE '%' || v.id::text || '%'
  ) OR EXISTS (
    SELECT 1 FROM target_stores d WHERE so.name LIKE '%' || d.id::text || '%'
  )
), totals AS (
  SELECT jsonb_build_object(
    'organizations',(SELECT count(*) FROM public.organizations),
    'stores',(SELECT count(*) FROM public.dealerships),
    'profiles',(SELECT count(*) FROM public.profiles),
    'memberships',(SELECT count(*) FROM public.profile_dealerships),
    'vehicles',(SELECT count(*) FROM public.vehicles),
    'photos',(SELECT count(*) FROM public.photos),
    'mediaAssets',(SELECT count(*) FROM public.media_assets),
    'mediaVariants',(SELECT count(*) FROM public.media_variants),
    'captureSessions',(SELECT count(*) FROM public.photo_capture_sessions),
    'generatedDocuments',(SELECT count(*) FROM public.generated_documents),
    'payoutRules',(SELECT count(*) FROM public.payout_rules),
    'payoutEntries',(SELECT count(*) FROM public.payout_entries),
    'activityEvents',(SELECT count(*) FROM public.activity_events),
    'auditEvents',(SELECT count(*) FROM public.audit_events),
    'backgroundJobs',(SELECT count(*) FROM private.background_jobs),
    'backgroundJobAttempts',(SELECT count(*) FROM private.background_job_attempts),
    'storageObjects',(SELECT count(*) FROM storage.objects),
    'authUsers',(SELECT count(*) FROM auth.users),
    'integrations',(SELECT count(*) FROM public.integration_connections)
  ) value
), target_counts AS (
  SELECT jsonb_build_object(
    'organizations',(SELECT count(*) FROM target_organizations),
    'stores',(SELECT count(*) FROM target_stores),
    'profiles',(SELECT count(*) FROM target_profiles),
    'memberships',(SELECT count(*) FROM public.profile_dealerships WHERE dealership_id = ANY(${storeIdsSql}) OR profile_id = ANY(${profileIdsSql})),
    'vehicles',(SELECT count(*) FROM target_vehicles),
    'photos',(SELECT count(*) FROM target_photos),
    'mediaAssets',(SELECT count(*) FROM target_assets),
    'mediaVariants',(SELECT count(*) FROM target_variants),
    'captureSessions',(SELECT count(*) FROM target_sessions),
    'generatedDocuments',(SELECT count(*) FROM public.generated_documents WHERE dealership_id = ANY(${storeIdsSql})),
    'payoutRules',(SELECT count(*) FROM public.payout_rules WHERE dealership_id = ANY(${storeIdsSql})),
    'payoutEntries',(SELECT count(*) FROM public.payout_entries WHERE dealership_id = ANY(${storeIdsSql})),
    'activityEvents',(SELECT count(*) FROM public.activity_events WHERE dealership_id = ANY(${storeIdsSql})),
    'auditEventsPreserved',(SELECT count(*) FROM public.audit_events WHERE dealership_id = ANY(${storeIdsSql}) OR actor_profile_id = ANY(${profileIdsSql}) OR target_profile_id = ANY(${profileIdsSql})),
    'backgroundJobs',(SELECT count(*) FROM private.background_jobs WHERE dealership_id = ANY(${storeIdsSql})),
    'backgroundJobAttempts',(SELECT count(*) FROM private.background_job_attempts a JOIN private.background_jobs j ON j.id=a.job_id WHERE j.dealership_id = ANY(${storeIdsSql})),
    'storageObjects',(SELECT count(*) FROM matching_objects),
    'accountOperations',(SELECT count(*) FROM public.user_account_operations WHERE target_profile_id = ANY(${profileIdsSql}) OR primary_dealership_id = ANY(${storeIdsSql})),
    'integrations',(SELECT count(*) FROM public.integration_connections WHERE dealership_id = ANY(${storeIdsSql}))
  ) value
)
SELECT jsonb_build_object(
  'capturedAt',clock_timestamp(),
  'projectRef','${TARGET_PROJECT_REF}',
  'owner',(SELECT jsonb_build_object('id',id,'name',full_name,'role',role,'status',status,'primaryStoreId',dealership_id) FROM public.profiles WHERE id='${OWNER_PROFILE_ID}'::uuid),
  'retainedStore',(SELECT jsonb_build_object('id',id,'name',name,'organizationId',organization_id,'status',status) FROM public.dealerships WHERE id='${RETAINED_STORE_ID}'::uuid),
  'targetOrganizations',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'name',name,'createdAt',created_at) ORDER BY id),'[]'::jsonb) FROM target_organizations),
  'targetStores',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'name',name,'organizationId',organization_id,'createdAt',created_at) ORDER BY id),'[]'::jsonb) FROM target_stores),
  'targetProfiles',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'name',full_name,'role',role,'status',status,'primaryStoreId',dealership_id) ORDER BY id),'[]'::jsonb) FROM target_profiles),
  'targetVehicles',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'stock',stock_number,'vin',vin,'sourceProvider',source_provider,'sourceMetadata',source_metadata,'storeId',dealership_id) ORDER BY id),'[]'::jsonb) FROM target_vehicles),
  'targetStorageObjects',(SELECT COALESCE(jsonb_agg(jsonb_build_object('bucket',bucket_id,'path',object_path,'byteSize',byte_size,'contentType',content_type) ORDER BY bucket_id,object_path),'[]'::jsonb) FROM matching_objects),
  'totals',(SELECT value FROM totals),
  'targetCounts',(SELECT value FROM target_counts),
  'retainedCounts',jsonb_build_object(
    'vehicles',(SELECT count(*) FROM public.vehicles WHERE dealership_id='${RETAINED_STORE_ID}'::uuid),
    'photos',(SELECT count(*) FROM public.photos p JOIN public.vehicles v ON v.id=p.vehicle_id WHERE v.dealership_id='${RETAINED_STORE_ID}'::uuid),
    'mediaAssets',(SELECT count(*) FROM public.media_assets WHERE dealership_id='${RETAINED_STORE_ID}'::uuid),
    'generatedDocuments',(SELECT count(*) FROM public.generated_documents WHERE dealership_id='${RETAINED_STORE_ID}'::uuid),
    'backdrops',(SELECT count(*) FROM public.backdrops WHERE dealership_id='${RETAINED_STORE_ID}'::uuid),
    'overlays',(SELECT count(*) FROM public.overlay_templates WHERE dealership_id='${RETAINED_STORE_ID}'::uuid),
    'documentAssets',(SELECT count(*) FROM public.documents WHERE dealership_id='${RETAINED_STORE_ID}'::uuid)
  ),
  'legacyEditorArtifacts',(SELECT COALESCE(jsonb_agg(jsonb_build_object('bucket',bucket_id,'path',name,'byteSize',COALESCE((metadata->>'size')::bigint,0)) ORDER BY name),'[]'::jsonb) FROM storage.objects WHERE bucket_id='vehicle-photos' AND name IN (
    '9061e595-6031-41a8-8520-0336ee438fe7/b906157c-6e15-4743-be5f-671ff37815a7.png',
    '9061e595-6031-41a8-8520-0336ee438fe7/cutouts/b3833d83-2990-43dc-a076-6463b802d958.png'
  ))
)::text;`;
}

function validateManifest(manifest, { allowAlreadyClean = true } = {}) {
  if (manifest.projectRef !== TARGET_PROJECT_REF) throw new Error("Manifest project mismatch.");
  if (
    manifest.owner?.id !== OWNER_PROFILE_ID ||
    manifest.owner?.role !== "owner" ||
    manifest.owner?.status !== "active"
  ) {
    throw new Error("Safety stop: the preserved Owner profile is missing or not active.");
  }
  if (
    manifest.retainedStore?.id !== RETAINED_STORE_ID ||
    manifest.retainedStore?.name !== RETAINED_STORE_NAME
  ) {
    throw new Error("Safety stop: the retained Owner testing store is not the audited store.");
  }
  if (manifest.totals.integrations !== 0 || manifest.targetCounts.integrations !== 0) {
    throw new Error("Safety stop: external integration connections are present.");
  }

  const clean = manifest.targetCounts.organizations === 0 && manifest.targetCounts.stores === 0;
  if (clean && allowAlreadyClean) return "already-clean";

  const expectedOrganizationNames = new Map(
    ACCEPTANCE_ORGANIZATIONS.map((row) => [row.id, row.name]),
  );
  if (manifest.targetOrganizations.length !== ACCEPTANCE_ORGANIZATIONS.length) {
    throw new Error(
      "Safety stop: acceptance organization count differs from the audited manifest.",
    );
  }
  for (const row of manifest.targetOrganizations) {
    if (expectedOrganizationNames.get(row.id) !== row.name) {
      throw new Error(`Safety stop: organization ${row.id} is not an audited acceptance fixture.`);
    }
  }
  if (manifest.targetStores.length !== ACCEPTANCE_ORGANIZATIONS.length) {
    throw new Error("Safety stop: acceptance store count differs from the audited manifest.");
  }
  for (const row of manifest.targetStores) {
    if (expectedOrganizationNames.get(row.id) !== row.name || row.organizationId !== row.id) {
      throw new Error(
        `Safety stop: store ${row.id} no longer matches the audited fixture topology.`,
      );
    }
  }

  const expectedProfiles = new Map(ACCEPTANCE_PROFILES.map((row) => [row.id, row.name]));
  if (manifest.targetProfiles.length !== ACCEPTANCE_PROFILES.length) {
    throw new Error("Safety stop: acceptance profile count differs from the audited manifest.");
  }
  for (const row of manifest.targetProfiles) {
    if (expectedProfiles.get(row.id) !== row.name) {
      throw new Error(`Safety stop: profile ${row.id} is not an audited acceptance identity.`);
    }
  }

  if (manifest.targetVehicles.length !== 16) {
    throw new Error("Safety stop: acceptance vehicle count is not exactly 16.");
  }
  for (const vehicle of manifest.targetVehicles) {
    if (
      vehicle.sourceProvider !== "acceptance_fixture" ||
      vehicle.sourceMetadata?.acceptance_fixture !== true ||
      vehicle.sourceMetadata?.syndication_disabled !== true
    ) {
      throw new Error(`Safety stop: vehicle ${vehicle.id} lacks explicit acceptance markers.`);
    }
  }
  if (manifest.legacyEditorArtifacts.length !== 2) {
    throw new Error("Safety stop: the two retained legacy editor artifacts were not both found.");
  }
  return "ready";
}

function cleanupSql() {
  return `
BEGIN;
DO $guard$
DECLARE
  _owner_count integer;
  _store_count integer;
  _vehicle_count integer;
BEGIN
  SELECT count(*) INTO _owner_count FROM public.profiles
  WHERE id='${OWNER_PROFILE_ID}'::uuid AND role='owner' AND status='active';
  SELECT count(*) INTO _store_count FROM public.dealerships
  WHERE id = ANY(${storeIdsSql}) AND name IN ('DealerShot Acceptance Store A','DealerShot Acceptance Store B');
  SELECT count(*) INTO _vehicle_count FROM public.vehicles
  WHERE dealership_id = ANY(${storeIdsSql})
    AND source_provider='acceptance_fixture'
    AND source_metadata @> '{"acceptance_fixture":true,"syndication_disabled":true}'::jsonb;
  IF _owner_count <> 1 OR _store_count <> 2 OR _vehicle_count <> 16 THEN
    RAISE EXCEPTION 'acceptance cleanup guard failed (owner %, stores %, vehicles %)', _owner_count, _store_count, _vehicle_count;
  END IF;
END
$guard$;

DELETE FROM private.background_jobs WHERE dealership_id = ANY(${storeIdsSql});
DELETE FROM public.user_account_operation_dealerships
WHERE dealership_id = ANY(${storeIdsSql})
   OR operation_id IN (
     SELECT id FROM public.user_account_operations
     WHERE target_profile_id = ANY(${profileIdsSql}) OR primary_dealership_id = ANY(${storeIdsSql})
   );
DELETE FROM public.user_account_operations
WHERE target_profile_id = ANY(${profileIdsSql}) OR primary_dealership_id = ANY(${storeIdsSql});

DELETE FROM public.bulk_photo_items
WHERE session_id IN (SELECT id FROM public.photo_capture_sessions WHERE dealership_id = ANY(${storeIdsSql}))
   OR photo_id IN (SELECT p.id FROM public.photos p JOIN public.vehicles v ON v.id=p.vehicle_id WHERE v.dealership_id = ANY(${storeIdsSql}))
   OR media_asset_id IN (SELECT id FROM public.media_assets WHERE dealership_id = ANY(${storeIdsSql}));
UPDATE public.photos p SET approved_variant_id=NULL, media_asset_id=NULL
FROM public.vehicles v WHERE p.vehicle_id=v.id AND v.dealership_id = ANY(${storeIdsSql});
DELETE FROM private.media_storage_migrations
WHERE media_asset_id IN (SELECT id FROM public.media_assets WHERE dealership_id = ANY(${storeIdsSql}));
DELETE FROM public.media_variants
WHERE media_asset_id IN (SELECT id FROM public.media_assets WHERE dealership_id = ANY(${storeIdsSql}));
DELETE FROM public.photos
WHERE vehicle_id IN (SELECT id FROM public.vehicles WHERE dealership_id = ANY(${storeIdsSql}));
DELETE FROM public.media_assets WHERE dealership_id = ANY(${storeIdsSql});

DELETE FROM public.dealerships WHERE id = ANY(${storeIdsSql});
DELETE FROM public.organizations WHERE id = ANY(${organizationIdsSql});
COMMIT;`;
}

function client(url, key) {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

function serviceRoleKey(projectRef) {
  const keys = supabaseJson(["projects", "api-keys", "--project-ref", projectRef, "--reveal"]);
  const service = keys.find((key) => key.name === "service_role" && key.type === "legacy");
  if (!service?.api_key) throw new Error("Supabase CLI did not return the service role key.");
  return service.api_key;
}

function safeLocalObjectPath(root, bucket, objectPath) {
  if (!objectPath || objectPath.includes("\\") || objectPath.split("/").includes("..")) {
    throw new Error(`Unsafe Storage object path: ${objectPath}`);
  }
  const encoded = objectPath.split("/").map(encodeURIComponent);
  return join(root, "storage", encodeURIComponent(bucket), ...encoded);
}

async function backupStorage(admin, objects, backupDir) {
  const records = [];
  for (const object of objects) {
    const { data, error } = await admin.storage.from(object.bucket).download(object.path);
    if (error || !data)
      throw new Error(
        `Storage backup failed for ${object.bucket}/${object.path}: ${safeMessage(error)}`,
      );
    const bytes = Buffer.from(await data.arrayBuffer());
    if (bytes.length !== Number(object.byteSize)) {
      throw new Error(`Storage byte-size mismatch for ${object.bucket}/${object.path}.`);
    }
    const localPath = safeLocalObjectPath(backupDir, object.bucket, object.path);
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, bytes, { flag: "wx" });
    records.push({
      ...object,
      localPath: localPath.slice(resolve(backupDir).length + 1),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return records;
}

async function removeStorage(admin, objects) {
  const groups = new Map();
  for (const object of objects) {
    const paths = groups.get(object.bucket) ?? [];
    paths.push(object.path);
    groups.set(object.bucket, paths);
  }
  for (const [bucket, paths] of groups) {
    for (let offset = 0; offset < paths.length; offset += 100) {
      const { error } = await admin.storage.from(bucket).remove(paths.slice(offset, offset + 100));
      if (error) throw new Error(`Storage cleanup failed in ${bucket}: ${safeMessage(error)}`);
    }
  }
}

async function restoreStorage(admin, backupRecords, backupDir) {
  const { readFileSync } = await import("node:fs");
  for (const record of backupRecords) {
    const bytes = readFileSync(join(backupDir, record.localPath));
    const { error } = await admin.storage.from(record.bucket).upload(record.path, bytes, {
      contentType: record.contentType || "application/octet-stream",
      upsert: false,
    });
    if (error && !String(error.message).includes("already exists")) {
      throw new Error(
        `Storage rollback failed for ${record.bucket}/${record.path}: ${safeMessage(error)}`,
      );
    }
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.projectRef !== TARGET_PROJECT_REF) {
    throw new Error(`Safety stop: --project-ref must be exactly ${TARGET_PROJECT_REF}.`);
  }
  if (options.execute && options.confirmation !== EXECUTION_CONFIRMATION) {
    throw new Error("Safety stop: the exact staging cleanup confirmation is required.");
  }
  if (options.execute && !options.backupDir) {
    throw new Error("Safety stop: --backup-dir is required for execution.");
  }
  if (options.execute && options.validateTransaction) {
    throw new Error("Safety stop: --execute and --validate-transaction are mutually exclusive.");
  }

  const projectsResult = supabaseJson(["projects", "list"]);
  const projects = Array.isArray(projectsResult) ? projectsResult : projectsResult.projects;
  const project = projects?.find((candidate) => candidate.ref === TARGET_PROJECT_REF);
  if (project?.name !== TARGET_PROJECT_NAME || project?.status !== "ACTIVE_HEALTHY") {
    throw new Error("Safety stop: the target is not the active DealerShot staging project.");
  }

  const psql = discoverPsql();
  const connection = temporaryDatabaseConnection(options.projectRef);
  const manifest = psqlQuery(psql, connection, manifestSql());
  const phase = validateManifest(manifest);
  const output = {
    mode: options.execute ? "execute" : "dry-run",
    phase,
    ...manifest,
  };

  if (options.validateTransaction && phase === "ready") {
    const rollbackSql = cleanupSql().replace(/COMMIT;\s*$/, "ROLLBACK;");
    psqlExecute(psql, connection, rollbackSql);
    const reconciled = psqlQuery(psql, connection, manifestSql());
    validateManifest(reconciled);
    if (JSON.stringify(reconciled.totals) !== JSON.stringify(manifest.totals)) {
      throw new Error("Rolled-back cleanup validation changed durable table totals.");
    }
    output.transactionValidation = "rolled-back-cleanly";
  }

  if (!options.execute) {
    if (options.manifestPath) writeJson(resolve(options.manifestPath), output);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  if (phase === "already-clean") {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  const backupDir = resolve(options.backupDir);
  if (!existsSync(join(backupDir, "business-and-ops.dump"))) {
    throw new Error("Safety stop: the pre-cleanup business-and-ops.dump is missing.");
  }
  const key = serviceRoleKey(options.projectRef);
  const admin = client(`https://${options.projectRef}.supabase.co`, key);
  let backupRecords = [];
  try {
    backupRecords = await backupStorage(admin, manifest.targetStorageObjects, backupDir);
    writeJson(join(backupDir, "storage-object-backup-manifest.json"), backupRecords);
    writeJson(join(backupDir, "executed-cleanup-manifest.json"), output);
    await removeStorage(admin, manifest.targetStorageObjects);
    try {
      psqlExecute(psql, connection, cleanupSql());
    } catch (error) {
      await restoreStorage(admin, backupRecords, backupDir);
      throw error;
    }

    const deletedAuthUsers = [];
    for (const profile of ACCEPTANCE_PROFILES) {
      const { error } = await admin.auth.admin.deleteUser(profile.id);
      if (error && !String(error.message).toLowerCase().includes("not found")) {
        throw new Error(`Auth cleanup failed for ${profile.id}: ${safeMessage(error)}`);
      }
      deletedAuthUsers.push(profile.id);
    }

    const postManifest = psqlQuery(psql, connection, manifestSql());
    const postPhase = validateManifest(postManifest);
    if (postPhase !== "already-clean")
      throw new Error("Post-cleanup verification did not reach the clean state.");
    const result = {
      mode: "execute",
      phase: postPhase,
      deletedAuthUserCount: deletedAuthUsers.length,
      backedUpStorageObjectCount: backupRecords.length,
      before: manifest,
      after: postManifest,
    };
    writeJson(join(backupDir, "post-cleanup-reconciliation.json"), result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    connection.PGPASSWORD = "";
  }
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`ERROR ${safeMessage(error)}\n`);
    process.exitCode = 1;
  });
}
