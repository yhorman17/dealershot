-- Bulk Capture is the product default. Guided Capture remains available only
-- when a store explicitly enables it.

ALTER TABLE public.photography_settings
  ALTER COLUMN guided_capture_enabled SET DEFAULT false;

-- The earlier Bulk-first migration populated existing rows with Guided=true.
-- Preserve any store that subsequently saved an explicit capture-method choice,
-- while moving untouched inherited defaults to Bulk-only.
WITH inherited_defaults AS (
  UPDATE public.photography_settings AS settings
  SET guided_capture_enabled = false,
      default_capture_method = 'bulk',
      updated_at = now()
  WHERE settings.guided_capture_enabled
    AND NOT EXISTS (
      SELECT 1
      FROM public.audit_events AS event
      WHERE event.dealership_id = settings.dealership_id
        AND event.event_type = 'configuration.capture_methods_changed'
    )
  RETURNING settings.dealership_id
)
INSERT INTO public.audit_events (event_type, dealership_id, payload)
SELECT
  'configuration.guided_capture_default_disabled',
  inherited_defaults.dealership_id,
  jsonb_build_object(
    'bulk_enabled', true,
    'guided_enabled', false,
    'default_method', 'bulk',
    'reason', 'product_default'
  )
FROM inherited_defaults;

CREATE OR REPLACE FUNCTION private.capture_method_enabled(
  _dealership_id uuid,
  _mode text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE _mode
    WHEN 'bulk' THEN coalesce(settings.bulk_capture_enabled, true)
    WHEN 'guided' THEN coalesce(settings.guided_capture_enabled, false)
    ELSE false
  END
  FROM (SELECT 1) AS seed
  LEFT JOIN public.photography_settings AS settings
    ON settings.dealership_id = _dealership_id;
$$;

CREATE OR REPLACE FUNCTION public.get_capture_method_configuration(_dealership_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  settings public.photography_settings%ROWTYPE;
BEGIN
  IF NOT private.current_user_has_active_membership(_dealership_id) THEN
    RAISE EXCEPTION 'Capture settings are unavailable.' USING ERRCODE='42501';
  END IF;

  SELECT * INTO settings
  FROM public.photography_settings
  WHERE dealership_id = _dealership_id;

  RETURN jsonb_build_object(
    'bulk_enabled', coalesce(settings.bulk_capture_enabled, true),
    'guided_enabled', coalesce(settings.guided_capture_enabled, false),
    'default_method', coalesce(settings.default_capture_method, 'bulk')
  );
END;
$$;

REVOKE ALL ON FUNCTION private.capture_method_enabled(uuid,text)
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_capture_method_configuration(uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_capture_method_configuration(uuid) TO authenticated;
