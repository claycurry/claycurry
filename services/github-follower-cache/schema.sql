-- GitHub Follower Cache - Graph Schema
-- Stores the social graph of GitHub users as nodes (users) and edges (follows).

CREATE TABLE IF NOT EXISTS github_users (
  username        TEXT PRIMARY KEY,
  display_name    TEXT,
  bio             TEXT,
  profile_readme  TEXT,
  avatar_url      TEXT,
  links           JSONB NOT NULL DEFAULT '[]',
  github_id       BIGINT,
  fetched_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS github_follows (
  follower    TEXT NOT NULL REFERENCES github_users(username) ON DELETE CASCADE,
  following   TEXT NOT NULL REFERENCES github_users(username) ON DELETE CASCADE,
  discovered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower, following)
);

CREATE INDEX IF NOT EXISTS idx_follows_follower  ON github_follows(follower);
CREATE INDEX IF NOT EXISTS idx_follows_following ON github_follows(following);

CREATE TABLE IF NOT EXISTS github_crawl_queue (
  username        TEXT PRIMARY KEY REFERENCES github_users(username) ON DELETE CASCADE,
  depth           INTEGER NOT NULL DEFAULT 0,
  priority        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  last_crawled_at TIMESTAMPTZ,
  next_crawl_at   TIMESTAMPTZ,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crawl_queue_status ON github_crawl_queue(status, priority DESC, next_crawl_at ASC);

-- Track rate limit state persistently so restarts don't cause bursts.
CREATE TABLE IF NOT EXISTS github_rate_limit_state (
  id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  remaining       INTEGER NOT NULL DEFAULT 5000,
  limit_total     INTEGER NOT NULL DEFAULT 5000,
  reset_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO github_rate_limit_state (id) VALUES (1) ON CONFLICT DO NOTHING;
