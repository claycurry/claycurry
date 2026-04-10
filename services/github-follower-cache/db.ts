import postgres from 'postgres';
import type {
  GitHubUserProfile,
  RateLimitState,
  CrawlQueueEntry,
} from './types';

const CACHE_TTL_DAYS = 5;

export class CacheDatabase {
  private sql: postgres.Sql;

  constructor(connectionString: string) {
    this.sql = postgres(connectionString, { ssl: 'allow' });
  }

  /** Run the schema migration. */
  async migrate(): Promise<void> {
    const fs = await import('fs');
    const path = await import('path');
    const schemaPath = path.join(
      (import.meta as unknown as { dir?: string }).dir ?? __dirname,
      'schema.sql',
    );
    const schema = fs.readFileSync(schemaPath, 'utf-8');

    // Split on semicolons and execute each statement.
    const statements = schema
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
      await this.sql.unsafe(stmt);
    }
  }

  // ─── User Operations ───────────────────────────────────────────────

  async upsertUser(user: GitHubUserProfile): Promise<void> {
    await this.sql`
      INSERT INTO github_users (
        username, display_name, bio, profile_readme,
        avatar_url, links, github_id, fetched_at, updated_at
      ) VALUES (
        ${user.username},
        ${user.displayName},
        ${user.bio},
        ${user.profileReadme},
        ${user.avatarUrl},
        ${JSON.stringify(user.links)}::jsonb,
        ${user.githubId},
        ${user.fetchedAt},
        NOW()
      )
      ON CONFLICT (username) DO UPDATE SET
        display_name    = EXCLUDED.display_name,
        bio             = EXCLUDED.bio,
        profile_readme  = EXCLUDED.profile_readme,
        avatar_url      = EXCLUDED.avatar_url,
        links           = EXCLUDED.links,
        github_id       = EXCLUDED.github_id,
        fetched_at      = EXCLUDED.fetched_at,
        updated_at      = NOW()
    `;
  }

  /** Ensure a user row exists (stub with just the username). */
  async ensureUser(username: string): Promise<void> {
    await this.sql`
      INSERT INTO github_users (username)
      VALUES (${username})
      ON CONFLICT (username) DO NOTHING
    `;
  }

  async getUser(username: string): Promise<GitHubUserProfile | null> {
    const rows = await this.sql`
      SELECT username, display_name, bio, profile_readme,
             avatar_url, links, github_id, fetched_at
      FROM github_users WHERE username = ${username}
    `;
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      username: r.username,
      displayName: r.display_name,
      bio: r.bio,
      profileReadme: r.profile_readme,
      avatarUrl: r.avatar_url,
      links: r.links ?? [],
      githubId: r.github_id,
      fetchedAt: r.fetched_at,
    };
  }

  async getAllUsers(limit = 100, offset = 0): Promise<GitHubUserProfile[]> {
    const rows = await this.sql`
      SELECT username, display_name, bio, profile_readme,
             avatar_url, links, github_id, fetched_at
      FROM github_users
      WHERE fetched_at IS NOT NULL
      ORDER BY username
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map((r) => ({
      username: r.username,
      displayName: r.display_name,
      bio: r.bio,
      profileReadme: r.profile_readme,
      avatarUrl: r.avatar_url,
      links: r.links ?? [],
      githubId: r.github_id,
      fetchedAt: r.fetched_at,
    }));
  }

  // ─── Follow Edge Operations ────────────────────────────────────────

  /** Replace the full follower list for a user in a single transaction. */
  async setFollowers(username: string, followers: string[]): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM github_follows WHERE following = ${username}`;
      for (const follower of followers) {
        await tx`
          INSERT INTO github_follows (follower, following, last_verified_at)
          VALUES (${follower}, ${username}, NOW())
          ON CONFLICT (follower, following) DO UPDATE SET
            last_verified_at = NOW()
        `;
      }
    });
  }

  /** Replace the full following list for a user in a single transaction. */
  async setFollowing(username: string, following: string[]): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM github_follows WHERE follower = ${username}`;
      for (const target of following) {
        await tx`
          INSERT INTO github_follows (follower, following, last_verified_at)
          VALUES (${username}, ${target}, NOW())
          ON CONFLICT (follower, following) DO UPDATE SET
            last_verified_at = NOW()
        `;
      }
    });
  }

  async getFollowers(username: string): Promise<string[]> {
    const rows = await this.sql`
      SELECT follower FROM github_follows
      WHERE following = ${username}
      ORDER BY follower
    `;
    return rows.map((r) => r.follower);
  }

  async getFollowing(username: string): Promise<string[]> {
    const rows = await this.sql`
      SELECT following FROM github_follows
      WHERE follower = ${username}
      ORDER BY following
    `;
    return rows.map((r) => r.following);
  }

  async getFollowerCount(username: string): Promise<number> {
    const rows = await this.sql`
      SELECT COUNT(*)::int AS count FROM github_follows WHERE following = ${username}
    `;
    return rows[0].count;
  }

  async getFollowingCount(username: string): Promise<number> {
    const rows = await this.sql`
      SELECT COUNT(*)::int AS count FROM github_follows WHERE follower = ${username}
    `;
    return rows[0].count;
  }

  // ─── Crawl Queue Operations ────────────────────────────────────────

  /** Enqueue a user for crawling if not already queued. */
  async enqueue(username: string, depth: number): Promise<void> {
    await this.ensureUser(username);
    // Higher depth = lower priority.
    const priority = Math.max(1000 - depth, 0);
    await this.sql`
      INSERT INTO github_crawl_queue (username, depth, priority, status, next_crawl_at)
      VALUES (${username}, ${depth}, ${priority}, 'pending', NOW())
      ON CONFLICT (username) DO NOTHING
    `;
  }

  /**
   * Claim the next user to crawl. Returns null when the queue is empty.
   * Atomically sets status to 'in_progress' to prevent double-processing.
   */
  async dequeue(): Promise<CrawlQueueEntry | null> {
    const rows = await this.sql`
      UPDATE github_crawl_queue
      SET status = 'in_progress'
      WHERE username = (
        SELECT username FROM github_crawl_queue
        WHERE status = 'pending' AND (next_crawl_at IS NULL OR next_crawl_at <= NOW())
        ORDER BY priority DESC, next_crawl_at ASC NULLS FIRST
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING username, depth, priority, status, last_crawled_at, next_crawl_at
    `;
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      username: r.username,
      depth: r.depth,
      priority: r.priority,
      status: r.status,
      lastCrawledAt: r.last_crawled_at,
      nextCrawlAt: r.next_crawl_at,
    };
  }

  /** Mark a crawl as completed and schedule re-crawl after CACHE_TTL_DAYS. */
  async markCompleted(username: string): Promise<void> {
    const nextCrawl = new Date();
    nextCrawl.setDate(nextCrawl.getDate() + CACHE_TTL_DAYS);
    await this.sql`
      UPDATE github_crawl_queue
      SET status = 'pending',
          last_crawled_at = NOW(),
          next_crawl_at = ${nextCrawl}
      WHERE username = ${username}
    `;
  }

  /** Mark a crawl as failed with an error message. */
  async markFailed(username: string, error: string): Promise<void> {
    const retry = new Date();
    retry.setHours(retry.getHours() + 1);
    await this.sql`
      UPDATE github_crawl_queue
      SET status = 'pending',
          next_crawl_at = ${retry},
          error_message = ${error}
      WHERE username = ${username}
    `;
  }

  /**
   * Re-enqueue stale entries — users whose cache is older than CACHE_TTL_DAYS
   * and whose queue entry is currently 'completed' or has a past next_crawl_at.
   */
  async requeueStaleEntries(): Promise<number> {
    const staleThreshold = new Date();
    staleThreshold.setDate(staleThreshold.getDate() - CACHE_TTL_DAYS);
    const result = await this.sql`
      UPDATE github_crawl_queue
      SET status = 'pending', next_crawl_at = NOW()
      WHERE status != 'in_progress'
        AND last_crawled_at < ${staleThreshold}
        AND (next_crawl_at IS NULL OR next_crawl_at <= NOW())
      RETURNING username
    `;
    return result.length;
  }

  /** Reset stuck in_progress entries older than 30 minutes (crash recovery). */
  async resetStuckEntries(): Promise<number> {
    const result = await this.sql`
      UPDATE github_crawl_queue
      SET status = 'pending'
      WHERE status = 'in_progress'
        AND last_crawled_at < NOW() - INTERVAL '30 minutes'
      RETURNING username
    `;
    return result.length;
  }

  // ─── Rate Limit Persistence ────────────────────────────────────────

  async loadRateLimitState(): Promise<RateLimitState | null> {
    const rows = await this.sql`
      SELECT remaining, limit_total, reset_at
      FROM github_rate_limit_state WHERE id = 1
    `;
    if (rows.length === 0) return null;
    return {
      remaining: rows[0].remaining,
      limitTotal: rows[0].limit_total,
      resetAt: new Date(rows[0].reset_at),
    };
  }

  async saveRateLimitState(state: RateLimitState): Promise<void> {
    await this.sql`
      UPDATE github_rate_limit_state
      SET remaining = ${state.remaining},
          limit_total = ${state.limitTotal},
          reset_at = ${state.resetAt},
          updated_at = NOW()
      WHERE id = 1
    `;
  }

  // ─── Stats ─────────────────────────────────────────────────────────

  async getStats(): Promise<{
    totalUsers: number;
    totalEdges: number;
    pendingCrawls: number;
    lastCrawlAt: Date | null;
  }> {
    const [users, edges, pending, last] = await Promise.all([
      this.sql`SELECT COUNT(*)::int AS c FROM github_users WHERE fetched_at IS NOT NULL`,
      this.sql`SELECT COUNT(*)::int AS c FROM github_follows`,
      this.sql`SELECT COUNT(*)::int AS c FROM github_crawl_queue WHERE status = 'pending'`,
      this.sql`SELECT MAX(last_crawled_at) AS t FROM github_crawl_queue`,
    ]);
    return {
      totalUsers: users[0].c,
      totalEdges: edges[0].c,
      pendingCrawls: pending[0].c,
      lastCrawlAt: last[0].t ?? null,
    };
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
