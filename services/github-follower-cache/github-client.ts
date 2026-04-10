import type { GitHubApiUser, GitHubUserProfile, UserLink } from './types';
import { AdaptiveRateLimiter } from './rate-limiter';
import type { RateLimitState } from './types';

const GITHUB_API = 'https://api.github.com';

export class GitHubClient {
  private token: string;
  private rateLimiter: AdaptiveRateLimiter;

  constructor(token: string, initialRateState?: RateLimitState) {
    this.token = token;
    this.rateLimiter = new AdaptiveRateLimiter(initialRateState);
  }

  private async request<T>(path: string, acceptRaw = false): Promise<T | null> {
    await this.rateLimiter.waitForSlot();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'User-Agent': 'github-follower-cache/1.0',
    };
    if (acceptRaw) {
      headers['Accept'] = 'application/vnd.github.raw+json';
    } else {
      headers['Accept'] = 'application/vnd.github+json';
    }

    const res = await fetch(`${GITHUB_API}${path}`, { headers });
    this.rateLimiter.updateFromHeaders(res.headers);

    if (res.status === 404) return null;
    if (res.status === 403 || res.status === 429) {
      // Rate limited — the limiter will handle the backoff on the next call.
      console.warn(`[github-client] Rate limited (${res.status}) on ${path}`);
      return null;
    }
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status} on ${path}: ${await res.text()}`);
    }

    if (acceptRaw) return (await res.text()) as unknown as T;
    return (await res.json()) as T;
  }

  /** Fetch a single user's profile. */
  async getUser(username: string): Promise<GitHubUserProfile | null> {
    const data = await this.request<GitHubApiUser>(`/users/${username}`);
    if (!data) return null;

    const links: UserLink[] = [];
    if (data.blog) links.push({ type: 'website', url: data.blog });
    if (data.twitter_username) {
      links.push({ type: 'twitter', url: `https://twitter.com/${data.twitter_username}` });
    }
    if (data.html_url) links.push({ type: 'github', url: data.html_url });
    if (data.email) links.push({ type: 'email', url: `mailto:${data.email}` });

    return {
      username: data.login,
      displayName: data.name,
      bio: data.bio,
      profileReadme: null, // fetched separately
      avatarUrl: data.avatar_url,
      links,
      githubId: data.id,
      fetchedAt: new Date(),
    };
  }

  /** Fetch the profile README (the repo {username}/{username}/README.md). */
  async getProfileReadme(username: string): Promise<string | null> {
    return this.request<string>(
      `/repos/${username}/${username}/readme`,
      true,
    );
  }

  /**
   * Fetch all usernames from a paginated list endpoint.
   * Used for both /users/:user/followers and /users/:user/following.
   */
  async getPaginatedUsernames(
    path: string,
    maxPages = 50,
  ): Promise<string[]> {
    const usernames: string[] = [];
    let page = 1;

    while (page <= maxPages) {
      const data = await this.request<{ login: string }[]>(
        `${path}?per_page=100&page=${page}`,
      );
      if (!data || data.length === 0) break;
      for (const u of data) usernames.push(u.login);
      if (data.length < 100) break;
      page++;
    }

    return usernames;
  }

  /** Fetch all followers of a user. */
  async getFollowers(username: string): Promise<string[]> {
    return this.getPaginatedUsernames(`/users/${username}/followers`);
  }

  /** Fetch all users that a user follows. */
  async getFollowing(username: string): Promise<string[]> {
    return this.getPaginatedUsernames(`/users/${username}/following`);
  }

  getRateLimitState(): RateLimitState {
    return this.rateLimiter.getState();
  }
}
