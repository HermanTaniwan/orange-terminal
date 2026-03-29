-- IDX pengumuman.Id2 — stable id per announcement; skip re-download when already imported for project.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS idx_announcement_id TEXT;

CREATE INDEX IF NOT EXISTS documents_project_idx_announcement_id_idx
  ON documents (project_id, idx_announcement_id)
  WHERE deleted_at IS NULL AND idx_announcement_id IS NOT NULL;
