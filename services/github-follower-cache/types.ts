export interface GitHubUserProfile {
  username: string;
  displayName: string | null;
  bio: string | null;
  profileReadme: string | null;
  avatarUrl: string | null;
  links: UserLink[];
  githubId: number | null;
  fetchedAt: Date | null;
}

export interface UserLink {
  type: string;
  url: string;
}

export interface FollowEdge {
  follower: string;
  following: string;
}

export interface CrawlQueueEntry {
  username: string;
  depth: number;
  priority: number;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  lastCrawledAt: Date | null;
  nextCrawlAt: Date | null;
}

export interface RateLimitState {
  remaining: number;
  limitTotal: number;
  resetAt: Date;
}

export interface GitHubApiUser {
  login: string;
  id: number;
  name: string | null;
  bio: string | null;
  avatar_url: string;
  blog: string;
  twitter_username: string | null;
  html_url: string;
  company: string | null;
  email: string | null;
}

export interface CrawlResult {
  user: GitHubUserProfile;
  followers: string[];
  following: string[];
}
