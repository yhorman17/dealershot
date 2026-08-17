-- Cover the active ledger relationships used by migration finalization,
-- vehicle galleries, and Bulk Photos. Other advisor-reported foreign keys are
-- not indexed here because current product queries do not filter or join on
-- them independently.
CREATE INDEX IF NOT EXISTS media_storage_migrations_media_asset_idx
  ON private.media_storage_migrations (media_asset_id);

CREATE INDEX IF NOT EXISTS media_storage_migrations_media_variant_idx
  ON private.media_storage_migrations (media_variant_id);

CREATE INDEX IF NOT EXISTS photos_media_asset_idx
  ON public.photos (media_asset_id)
  WHERE media_asset_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bulk_photo_items_media_asset_idx
  ON public.bulk_photo_items (media_asset_id)
  WHERE media_asset_id IS NOT NULL;
