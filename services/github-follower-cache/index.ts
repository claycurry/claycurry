import { GitHubClient } from './github-client';
import { CacheDatabase } from './db';
import { GraphCrawler } from './crawler';

/**
 * GitHub Follower Cache Service
 *
 * A background service that continuously crawls the GitHub social graph
 * starting from seed users. It adaptively paces requests to stay below
 * the GitHub API rate limit and refreshes stale data every 5 days.
 *
 * Environment variables:
 *   GITHUB_TOKEN   – GitHub personal access token (required)
 *   POSTGRES_URL   – PostgreSQL connection string (required)
 *   SEED_USERS     – Comma-separated list of seed usernames (default: "claycurry")
 *
 * Usage:
 *   bun run services/github-follower-cache/index.ts
 */

const IDLE_POLL_INTERVAL_MS = 30_000; // 30s when queue is empty
const MAINTENANCE_INTERVAL_MS = 600_000; // 10min between maintenance sweeps

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const pgUrl = process.env.POSTGRES_URL;

  if (!token) {
    console.error('[service] GITHUB_TOKEN is required');
    process.exit(1);
  }
  if (!pgUrl) {
    console.error('[service] POSTGRES_URL is required');
    process.exit(1);
  }

  const seedUsers = (process.env.SEED_USERS ?? 'claycurry')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  console.log('[service] Starting GitHub Follower Cache Service');
  console.log(`[service] Seed users: ${seedUsers.join(', ')}`);

  // Initialize database and run migrations.
  const db = new CacheDatabase(pgUrl);
  await db.migrate();
  console.log('[service] Database schema migrated');

  // Restore persisted rate limit state so we don't burst after restart.
  const savedRateState = await db.loadRateLimitState();
  const client = new GitHubClient(token, savedRateState ?? undefined);
  const crawler = new GraphCrawler(client, db);

  // Seed initial users.
  await crawler.seed(seedUsers);

  // Recover any entries stuck as 'in_progress' from a prior crash.
  const recovered = await db.resetStuckEntries();
  if (recovered > 0) {
    console.log(`[service] Recovered ${recovered} stuck crawl entries`);
  }

  let lastMaintenance = Date.now();
  let running = true;

  // Graceful shutdown.
  const shutdown = async () => {
    console.log('[service] Shutting down...');
    running = false;
    await db.saveRateLimitState(client.getRateLimitState());
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // ── Main Loop ──────────────────────────────────────────────────────
  console.log('[service] Entering main crawl loop');

  while (running) {
    // Periodic maintenance: re-queue stale entries, recover stuck ones.
    if (Date.now() - lastMaintenance > MAINTENANCE_INTERVAL_MS) {
      const stale = await db.requeueStaleEntries();
      const stuck = await db.resetStuckEntries();
      if (stale > 0 || stuck > 0) {
        console.log(`[service] Maintenance: requeued ${stale} stale, recovered ${stuck} stuck`);
      }
      lastMaintenance = Date.now();
    }

    const didWork = await crawler.processOne();

    if (!didWork) {
      // Queue is empty — either everything is crawled or waiting for TTL expiry.
      const stats = await db.getStats();
      console.log(
        `[service] Queue empty. ` +
        `${stats.totalUsers} users, ${stats.totalEdges} edges, ` +
        `${stats.pendingCrawls} pending. ` +
        `Sleeping ${IDLE_POLL_INTERVAL_MS / 1000}s...`
      );
      await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_INTERVAL_MS));
    }
  }
}

main().catch((err) => {
  console.error('[service] Fatal error:', err);
  process.exit(1);
});
