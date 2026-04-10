import type { CacheDatabase } from './db';

/**
 * Build GraphQL root resolvers bound to a CacheDatabase instance.
 *
 * Each resolver field for GitHubUser that returns nested data
 * (followers, following, counts) lazily resolves from the DB,
 * so queries only pay for what they ask for.
 */
export function buildResolvers(db: CacheDatabase) {

  /** Wrap a raw DB user row into a GraphQL-compatible object with lazy fields. */
  function wrapUser(row: {
    username: string;
    displayName: string | null;
    bio: string | null;
    profileReadme: string | null;
    avatarUrl: string | null;
    links: { type: string; url: string }[];
    fetchedAt: Date | null;
  }) {
    return {
      username: row.username,
      displayName: row.displayName,
      bio: row.bio,
      profileReadme: row.profileReadme,
      avatarUrl: row.avatarUrl,
      links: row.links,
      fetchedAt: row.fetchedAt?.toISOString() ?? null,

      followerCount: () => db.getFollowerCount(row.username),
      followingCount: () => db.getFollowingCount(row.username),

      followers: async ({ limit = 50, offset = 0 }: { limit?: number; offset?: number }) => {
        const names = await db.getFollowers(row.username);
        const page = names.slice(offset, offset + limit);
        const users = await Promise.all(page.map((u) => db.getUser(u)));
        return users.filter(Boolean).map((u) => wrapUser(u!));
      },

      following: async ({ limit = 50, offset = 0 }: { limit?: number; offset?: number }) => {
        const names = await db.getFollowing(row.username);
        const page = names.slice(offset, offset + limit);
        const users = await Promise.all(page.map((u) => db.getUser(u)));
        return users.filter(Boolean).map((u) => wrapUser(u!));
      },
    };
  }

  return {
    user: async ({ username }: { username: string }) => {
      const row = await db.getUser(username);
      return row ? wrapUser(row) : null;
    },

    users: async ({ limit = 50, offset = 0 }: { limit?: number; offset?: number }) => {
      const rows = await db.getAllUsers(limit, offset);
      return rows.map(wrapUser);
    },

    followers: async ({ username }: { username: string }) => {
      return db.getFollowers(username);
    },

    following: async ({ username }: { username: string }) => {
      return db.getFollowing(username);
    },

    crawlStatus: async () => {
      const stats = await db.getStats();
      return {
        totalUsers: stats.totalUsers,
        totalEdges: stats.totalEdges,
        pendingCrawls: stats.pendingCrawls,
        lastCrawlAt: stats.lastCrawlAt?.toISOString() ?? null,
      };
    },
  };
}
