-- Canonical insights per content hash (aligned with embedding dedup cache).
ALTER TABLE embedding_cache_sets
  ADD COLUMN IF NOT EXISTS insights_json JSONB;
