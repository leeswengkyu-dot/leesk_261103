CREATE TABLE feeds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT NOT NULL,
  grade TEXT NOT NULL,
  is_party_source INTEGER NOT NULL DEFAULT 0,
  feed_type TEXT NOT NULL DEFAULT 'rss',
  url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  region TEXT NOT NULL,
  country TEXT,
  related_regions TEXT,
  location_name TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  coord_origin TEXT NOT NULL DEFAULT 'none',
  location_accuracy TEXT NOT NULL DEFAULT 'unknown',
  area_radius_km DOUBLE PRECISION,
  location_conflict INTEGER NOT NULL DEFAULT 0,
  content_conflict INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT,
  first_published_at TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'other',
  change_type TEXT NOT NULL DEFAULT 'new',
  source_count INTEGER NOT NULL DEFAULT 0,
  reliability TEXT NOT NULL DEFAULT 'low',
  alert_reasons TEXT NOT NULL DEFAULT '[]',
  review_status TEXT NOT NULL DEFAULT 'collected',
  merged_into TEXT REFERENCES events(id),
  summary_origin TEXT NOT NULL DEFAULT 'none',
  memo TEXT,
  conflict_note TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_events_region_occ ON events(region, occurred_at);
CREATE INDEX idx_events_review ON events(review_status);
CREATE INDEX idx_events_firstpub ON events(first_published_at);

CREATE TABLE articles (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id),
  feed_id TEXT REFERENCES feeds(id),
  source_name TEXT NOT NULL,
  source_grade TEXT NOT NULL,
  is_party_claim INTEGER NOT NULL DEFAULT 0,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  published_at TEXT NOT NULL,
  extracted_location_name TEXT,
  extracted_lat DOUBLE PRECISION,
  extracted_lng DOUBLE PRECISION,
  ai_status TEXT NOT NULL DEFAULT 'pending',
  fetched_at TEXT NOT NULL
);
CREATE INDEX idx_articles_event ON articles(event_id);
CREATE INDEX idx_articles_ai ON articles(ai_status);

CREATE TABLE summary_statements (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  position INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'unverified',
  fact_suggested INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  origin TEXT NOT NULL DEFAULT 'human',
  warnings TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_statements_event ON summary_statements(event_id);

CREATE TABLE statement_sources (
  statement_id TEXT NOT NULL REFERENCES summary_statements(id) ON DELETE CASCADE,
  article_id TEXT NOT NULL REFERENCES articles(id),
  PRIMARY KEY (statement_id, article_id)
);

CREATE TABLE duplicate_candidates (
  id TEXT PRIMARY KEY,
  event_a TEXT NOT NULL REFERENCES events(id),
  event_b TEXT NOT NULL REFERENCES events(id),
  status TEXT NOT NULL DEFAULT 'suggested',
  created_at TEXT NOT NULL,
  UNIQUE (event_a, event_b)
);

CREATE TABLE briefings (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  briefing_date TEXT NOT NULL,
  content TEXT NOT NULL,
  event_ids TEXT NOT NULL DEFAULT '[]',
  published_at TEXT,
  published_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE collection_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  results TEXT NOT NULL DEFAULT '[]',
  new_articles INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE ai_usage (
  usage_date TEXT PRIMARY KEY,
  call_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE pin_attempts (
  ip TEXT PRIMARY KEY,
  fail_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);
