import { GitHubClient } from './github-client';
import { CacheDatabase } from './db';
import type { CrawlResult } from './types';

/**
 * BFS graph crawler that visits GitHub users, fetches their profiles,
 * followers, and following lists, then enqueues newly discovered users.
 */
export class GraphCrawler {
  constructor(
    private client: GitHubClient,
    private db: CacheDatabase,
  ) {}

  /**
   * Seed the crawl queue with initial usernames at depth 0.
   * Existing entries are left untouched so in-progress state is preserved.
   */
  async seed(usernames: string[]): Promise<void> {
    for (const username of usernames) {
      await this.db.enqueue(username, 0);
    }
    console.log(`[crawler] Seeded ${usernames.length} user(s)`);
  }

  /**
   * Crawl a single user: fetch profile + readme + followers + following.
   * Returns the result or null if the user doesn't exist on GitHub.
   */
  async crawlUser(username: string): Promise<CrawlResult | null> {
    console.log(`[crawler] Crawling ${username}...`);

    const user = await this.client.getUser(username);
    if (!user) {
      console.warn(`[crawler] User ${username} not found, skipping`);
      return null;
    }

    // Fetch readme, followers, and following concurrently where possible.
    // Readme is a single request; followers/following are paginated.
    // We stagger them to avoid blowing through rate limit on a single user.
    const readme = await this.client.getProfileReadme(username);
    user.profileReadme = readme;

    const followers = await this.client.getFollowers(username);
    const following = await this.client.getFollowing(username);

    return { user, followers, following };
  }

  /**
   * Process one crawl result: persist the user, edges, and enqueue
   * any newly discovered users at depth+1.
   */
  async persistResult(result: CrawlResult, parentDepth: number): Promise<void> {
    const { user, followers, following } = result;

    // Persist the full user profile.
    await this.db.upsertUser(user);

    // Ensure all discovered usernames have stub rows so FK constraints hold.
    const allUsernames = new Set([...followers, ...following]);
    for (const u of allUsernames) {
      await this.db.ensureUser(u);
    }

    // Replace the edge sets atomically.
    await this.db.setFollowers(user.username, followers);
    await this.db.setFollowing(user.username, following);

    // Enqueue newly discovered users for future crawling.
    const nextDepth = parentDepth + 1;
    for (const u of allUsernames) {
      await this.db.enqueue(u, nextDepth);
    }

    console.log(
      `[crawler] ${user.username}: ` +
      `${followers.length} followers, ${following.length} following, ` +
      `${allUsernames.size} unique neighbors enqueued at depth ${nextDepth}`
    );
  }

  /**
   * Process a single item from the crawl queue: dequeue -> crawl -> persist.
   * Returns true if work was done, false if the queue was empty.
   */
  async processOne(): Promise<boolean> {
    const entry = await this.db.dequeue();
    if (!entry) return false;

    try {
      const result = await this.crawlUser(entry.username);

      if (result) {
        await this.persistResult(result, entry.depth);
      }

      await this.db.markCompleted(entry.username);
      // Persist rate limit state after each successful crawl.
      await this.db.saveRateLimitState(this.client.getRateLimitState());
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[crawler] Failed to crawl ${entry.username}: ${message}`);
      await this.db.markFailed(entry.username, message);
      return true; // Work was attempted even if it failed.
    }
  }
}
