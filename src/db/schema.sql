-- K-pop Live Versions & Covers — SQLite schema
-- Foreign keys are enforced by `PRAGMA foreign_keys = ON` in src/db/index.js.
-- All *_at columns are ISO-8601 UTC strings. operating_date is a local (Asia/Seoul) calendar date YYYY-MM-DD.

CREATE TABLE IF NOT EXISTS source_channels (
  id              INTEGER PRIMARY KEY,
  platform        TEXT    NOT NULL,                 -- youtube, instagram, tiktok ...
  external_id     TEXT    NOT NULL,                 -- official channel identifier on that platform
  name            TEXT    NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  is_test         INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0,1)),
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (platform, external_id)
);

CREATE TABLE IF NOT EXISTS source_videos (
  id                 INTEGER PRIMARY KEY,
  channel_id         INTEGER NOT NULL REFERENCES source_channels(id) ON DELETE RESTRICT,
  platform           TEXT    NOT NULL,
  platform_video_id  TEXT    NOT NULL,
  official_url       TEXT    NOT NULL,
  title              TEXT    NOT NULL,
  description        TEXT,
  published_at       TEXT    NOT NULL,              -- UTC
  is_active          INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),  -- deactivated: its candidates are never selected
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (platform, platform_video_id)              -- dedupe on (platform, platform video id)
);

CREATE TABLE IF NOT EXISTS tracks (
  id                  INTEGER PRIMARY KEY,
  track_key           TEXT    NOT NULL UNIQUE,
  original_artist_en  TEXT,                         -- official English artist name (NULL if not verified)
  original_artist_ko  TEXT,
  title_en            TEXT,                         -- official English title (NULL if not verified)
  title_ko            TEXT,
  name_evidence       TEXT                          -- where the official spellings were confirmed
);

CREATE TABLE IF NOT EXISTS performance_candidates (
  id                    INTEGER PRIMARY KEY,
  candidate_key         TEXT    NOT NULL UNIQUE,    -- stable id used for deterministic tie-break
  source_video_id       INTEGER NOT NULL REFERENCES source_videos(id) ON DELETE RESTRICT,
  track_id              INTEGER REFERENCES tracks(id) ON DELETE RESTRICT,
  performer_en          TEXT,                       -- official English performer name (actual performer)
  performer_ko          TEXT,
  program_name          TEXT,                       -- show / session / stage name
  performance_type      TEXT    CHECK (performance_type IN ('live','cover')),
  arrangement_tags      TEXT    NOT NULL DEFAULT '[]',  -- JSON array: band, acoustic, orchestra ...
  version_evidence      TEXT,                       -- source text that states the version difference
  segment_start_sec     INTEGER,                    -- verified recommended segment (official chapter etc.)
  segment_end_sec       INTEGER,
  segment_evidence      TEXT,                       -- NULL => link to full video, no timestamp
  why_watch_en          TEXT,                       -- one-line hook, only when backed by evidence
  why_watch_evidence    TEXT,
  occasion_note         TEXT,                       -- officially confirmed reason to feature it now
  occasion_date         TEXT,                       -- YYYY-MM-DD
  occasion_evidence     TEXT,
  watch_cues            TEXT    NOT NULL DEFAULT '[]', -- JSON [{at_sec, text_en, evidence}] — shown only when evidence is present
  judgement_notes       TEXT,                       -- operator / ingest notes on how this was verified
  is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),  -- deactivated: kept for the record, never selected
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (segment_start_sec IS NULL OR segment_end_sec IS NULL OR segment_end_sec > segment_start_sec)
);
CREATE INDEX IF NOT EXISTS idx_candidates_video ON performance_candidates(source_video_id);
CREATE INDEX IF NOT EXISTS idx_candidates_track ON performance_candidates(track_id);

CREATE TABLE IF NOT EXISTS clip_assets (
  id                 INTEGER PRIMARY KEY,
  asset_key          TEXT    NOT NULL UNIQUE,
  candidate_id       INTEGER NOT NULL REFERENCES performance_candidates(id) ON DELETE RESTRICT,
  file_ref           TEXT    NOT NULL,              -- path of the lawfully obtained file (relative to project root)
  source_start_sec   INTEGER NOT NULL,              -- intended range in the original
  source_end_sec     INTEGER NOT NULL,
  file_offset_sec    INTEGER NOT NULL DEFAULT 0,    -- where source_start_sec sits inside file_ref
  is_test_asset      INTEGER NOT NULL DEFAULT 0 CHECK (is_test_asset IN (0,1)),
  -- Operator's own file, cut only to see how a template looks. Rights are NOT verified, so this
  -- skips the rights categories below and can never pass the live path. Default off.
  personal_use_only  INTEGER NOT NULL DEFAULT 0 CHECK (personal_use_only IN (0,1)),
  notes              TEXT,
  CHECK (source_end_sec > source_start_sec)
);

CREATE TABLE IF NOT EXISTS usage_permissions (
  id                    INTEGER PRIMARY KEY,
  clip_asset_id         INTEGER NOT NULL REFERENCES clip_assets(id) ON DELETE CASCADE,
  rights_category       TEXT    NOT NULL,           -- footage, music, performance ...
  rights_holder         TEXT,
  status                TEXT    NOT NULL CHECK (status IN ('granted','pending','denied','revoked')),
  allows_edit           INTEGER NOT NULL DEFAULT 0 CHECK (allows_edit IN (0,1)),
  allows_repost         INTEGER NOT NULL DEFAULT 0 CHECK (allows_repost IN (0,1)),
  platforms             TEXT    NOT NULL DEFAULT '[]',  -- JSON array, e.g. ["instagram"]
  territories           TEXT    NOT NULL DEFAULT '[]',  -- JSON array of ISO codes or "WORLDWIDE"
  valid_from            TEXT,                       -- UTC
  valid_until           TEXT,                       -- UTC; NULL = no end date stated
  permitted_start_sec   INTEGER,
  permitted_end_sec     INTEGER,
  evidence_ref          TEXT,                       -- pointer only (e.g. evidence://...). Originals stay out of Git.
  is_test_permission    INTEGER NOT NULL DEFAULT 0 CHECK (is_test_permission IN (0,1)),
  UNIQUE (clip_asset_id, rights_category)
);

-- Segment suggestions from music-structure analysis (all-in-one). Suggestions only: an operator approves
-- before the clip's intended range changes. Always inside the permitted range; never shown as an official timestamp.
CREATE TABLE IF NOT EXISTS segment_suggestions (
  id                   INTEGER PRIMARY KEY,
  clip_asset_id        INTEGER NOT NULL REFERENCES clip_assets(id) ON DELETE CASCADE,
  analyzer             TEXT    NOT NULL,            -- allin1 | fixture
  analysis_ref         TEXT    NOT NULL,            -- cached analysis JSON path
  label                TEXT    NOT NULL,            -- chorus, solo, verse ...
  suggested_start_sec  REAL    NOT NULL,            -- source-video time
  suggested_end_sec    REAL    NOT NULL,
  file_start_sec       REAL    NOT NULL,            -- same point inside the clip file
  bpm                  REAL,
  notes                TEXT,
  status               TEXT    NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','superseded')),
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  decided_at           TEXT,
  CHECK (suggested_end_sec > suggested_start_sec)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_suggestion_open ON segment_suggestions(clip_asset_id, analyzer, suggested_start_sec, suggested_end_sec);

CREATE TABLE IF NOT EXISTS daily_selections (
  id                  INTEGER PRIMARY KEY,
  operating_date      TEXT    NOT NULL UNIQUE,      -- one selection per operating date (single account)
  candidate_id        INTEGER REFERENCES performance_candidates(id) ON DELETE RESTRICT,
  status              TEXT    NOT NULL CHECK (status IN ('selected','skipped')),
  score               INTEGER,
  score_breakdown     TEXT,                         -- JSON
  reason              TEXT,                         -- human-readable selection reason (English)
  reason_ko           TEXT,                         -- same verdict, written for the operator
  skip_reason         TEXT,
  skip_reason_ko      TEXT,
  rule_version        TEXT    NOT NULL,
  evaluation_snapshot TEXT,                         -- JSON: every candidate considered + why
  revision            INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK ((status = 'selected' AND candidate_id IS NOT NULL) OR (status = 'skipped' AND candidate_id IS NULL AND skip_reason IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS reels (
  id                  INTEGER PRIMARY KEY,
  selection_id        INTEGER NOT NULL UNIQUE REFERENCES daily_selections(id) ON DELETE CASCADE, -- one reel per selection
  clip_asset_id       INTEGER REFERENCES clip_assets(id) ON DELETE RESTRICT,                     -- NULL for original_graphic
  output_format       TEXT    NOT NULL CHECK (output_format IN ('licensed_clip','original_graphic')),
  template_id         TEXT,                         -- templates/reels/<id>.json used for rendering
  format_reason       TEXT    NOT NULL,
  format_reason_ko    TEXT,
  title_en            TEXT    NOT NULL,
  caption             TEXT    NOT NULL,
  official_link       TEXT    NOT NULL,             -- official URL (+ verified timestamp if any)
  guide_page_path     TEXT,                         -- local page that links the official original
  output_path         TEXT,                         -- MP4 path
  poster_path         TEXT,                         -- PNG first-frame preview
  render_status       TEXT    NOT NULL DEFAULT 'pending' CHECK (render_status IN ('pending','rendering','done','failed')),
  render_error        TEXT,
  render_attempts     INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK ((output_format = 'licensed_clip' AND clip_asset_id IS NOT NULL) OR (output_format = 'original_graphic' AND clip_asset_id IS NULL))
);

CREATE TABLE IF NOT EXISTS publish_jobs (
  id                    INTEGER PRIMARY KEY,
  reel_id               INTEGER NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  platform              TEXT    NOT NULL,
  mode                  TEXT    NOT NULL CHECK (mode IN ('dry_run','live')),
  scheduled_at          TEXT    NOT NULL,           -- UTC
  status                TEXT    NOT NULL CHECK (status IN ('simulated','blocked','queued','container_created','published','pending_confirmation','failed')),
  expected_status       TEXT,                       -- dry-run: what a live run would do
  expected_status_ko    TEXT,                       -- same, written for the operator
  plan_json             TEXT,                       -- dry-run: file, caption, schedule actually checked
  external_container_id TEXT,                       -- never fabricated in dry_run
  external_media_id     TEXT,                       -- never fabricated in dry_run
  last_error            TEXT,
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (reel_id, platform, mode),
  CHECK (mode = 'live' OR (external_container_id IS NULL AND external_media_id IS NULL))
);

CREATE TABLE IF NOT EXISTS metric_snapshots (
  id              INTEGER PRIMARY KEY,
  publish_job_id  INTEGER NOT NULL REFERENCES publish_jobs(id) ON DELETE CASCADE,
  observed_at     TEXT    NOT NULL,
  window_label    TEXT    CHECK (window_label IN ('24h','7d','other')),
  views           INTEGER,                          -- NULL when the platform does not expose it per post
  reach           INTEGER,
  likes           INTEGER,
  comments        INTEGER,
  shares          INTEGER,
  saves           INTEGER,
  follows         INTEGER,
  raw_json        TEXT
);

-- Country-level reach is account-level on Instagram; kept apart from per-post metrics.
CREATE TABLE IF NOT EXISTS account_metric_snapshots (
  id            INTEGER PRIMARY KEY,
  platform      TEXT NOT NULL,
  observed_at   TEXT NOT NULL,
  metric        TEXT NOT NULL,                      -- e.g. follower_demographics_country
  dimension     TEXT,                               -- e.g. US
  value         INTEGER,
  raw_json      TEXT
);
