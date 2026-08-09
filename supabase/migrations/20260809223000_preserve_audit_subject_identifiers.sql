-- Audit rows are immutable historical evidence. ON DELETE SET NULL foreign
-- keys conflict with that invariant because deleting a referenced profile or
-- dealership attempts to update the audit row and is rejected by the
-- append-only trigger. Preserve the UUIDs as historical identifiers instead.

ALTER TABLE public.audit_events
  DROP CONSTRAINT audit_events_actor_profile_id_fkey;

ALTER TABLE public.audit_events
  DROP CONSTRAINT audit_events_target_profile_id_fkey;

ALTER TABLE public.audit_events
  DROP CONSTRAINT audit_events_dealership_id_fkey;

COMMENT ON COLUMN public.audit_events.actor_profile_id IS
  'Immutable historical actor identifier; intentionally not a foreign key.';

COMMENT ON COLUMN public.audit_events.target_profile_id IS
  'Immutable historical target identifier; intentionally not a foreign key.';

COMMENT ON COLUMN public.audit_events.dealership_id IS
  'Immutable historical dealership identifier; intentionally not a foreign key.';
