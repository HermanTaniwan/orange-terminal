ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS project_type TEXT;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS ticker_symbol TEXT;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS exchange TEXT;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS industry_topic TEXT;

UPDATE projects
SET project_type = COALESCE(project_type, 'non_emiten')
WHERE project_type IS NULL;

ALTER TABLE projects
  ALTER COLUMN project_type SET DEFAULT 'non_emiten';

ALTER TABLE projects
  ALTER COLUMN project_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_project_type_check'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_project_type_check
      CHECK (project_type IN ('emiten', 'non_emiten'));
  END IF;
END $$;

