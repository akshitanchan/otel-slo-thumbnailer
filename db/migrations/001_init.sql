DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_status') THEN
    CREATE TYPE job_status AS ENUM ('queued', 'processing', 'succeeded', 'failed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'demo',
  idempotency_key TEXT NULL,

  input_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  sizes JSONB NOT NULL,

  status job_status NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  traceparent TEXT NULL,

  error_code TEXT NULL,
  error_message TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs (status, run_at, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_tenant_idem_key_uniq
  ON jobs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS outputs (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,

  size INT NOT NULL,
  output_path TEXT NOT NULL,
  bytes INT NOT NULL,
  format TEXT NOT NULL DEFAULT 'jpeg',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(job_id, size)
);

CREATE INDEX IF NOT EXISTS outputs_job_id_idx
  ON outputs (job_id);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jobs_updated_at ON jobs;

CREATE TRIGGER trg_jobs_updated_at
BEFORE UPDATE ON jobs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
