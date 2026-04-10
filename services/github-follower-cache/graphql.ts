import { buildSchema } from 'graphql';

export const typeDefs = buildSchema(/* GraphQL */ `
  type UserLink {
    type: String!
    url: String!
  }

  type GitHubUser {
    username: String!
    displayName: String
    bio: String
    profileReadme: String
    avatarUrl: String
    links: [UserLink!]!
    followerCount: Int!
    followingCount: Int!
    followers(limit: Int, offset: Int): [GitHubUser!]!
    following(limit: Int, offset: Int): [GitHubUser!]!
    fetchedAt: String
  }

  type CrawlStatus {
    totalUsers: Int!
    totalEdges: Int!
    pendingCrawls: Int!
    lastCrawlAt: String
  }

  type Query {
    """Fetch a single user by username."""
    user(username: String!): GitHubUser

    """List all cached users."""
    users(limit: Int = 50, offset: Int = 0): [GitHubUser!]!

    """Get the followers of a user (flat list of usernames)."""
    followers(username: String!): [String!]!

    """Get the users that a user follows (flat list of usernames)."""
    following(username: String!): [String!]!

    """Current crawl service statistics."""
    crawlStatus: CrawlStatus!
  }
`);
