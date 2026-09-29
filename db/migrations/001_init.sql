-- db/migrations/001_init.sql
-- Initial schema for Bulk Mailer

CREATE TABLE IF NOT EXISTS users (
  id           SERIAL PRIMARY KEY,
  username     VARCHAR(100) UNIQUE NOT NULL,
  display_name VARCHAR(200),
  department   VARCHAR(100),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
  id            SERIAL PRIMARY KEY,
  created_by    VARCHAR(100) NOT NULL,
  department    VARCHAR(100),
  from_address  VARCHAR(200) NOT NULL,
  subject_tpl   TEXT NOT NULL,
  body_tpl      TEXT NOT NULL,
  attachment_mode VARCHAR(20) NOT NULL DEFAULT 'network',
  -- attachment_mode values: zip | network
  total_rows    INTEGER NOT NULL DEFAULT 0,
  sent_count    INTEGER NOT NULL DEFAULT 0,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- status values: pending | running | paused | completed | failed
  scheduled_at  TIMESTAMPTZ,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS send_logs (
  id               SERIAL PRIMARY KEY,
  job_id           INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  recipient_email  VARCHAR(300) NOT NULL,
  recipient_name   VARCHAR(300),
  subject          TEXT,
  attachment_path  TEXT,
  row_data         JSONB,
  status           VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- status values: pending | sent | failed | skipped
  error_message    TEXT,
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_send_logs_job_id ON send_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_send_logs_status  ON send_logs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_status        ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_by    ON jobs(created_by);
