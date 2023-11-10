import { Octokit } from '@octokit/core';

export interface ResolveRefToShaOptions {
  repoURL: string;
  ref: string;
}

export interface GitHubClient {
  resolveRefToSha(options: ResolveRefToShaOptions): Promise<string>;
}

export class OctokitGitHubClient {
  constructor(private octokit: Octokit) {}
  async resolveRefToSha(): Promise<string> {
    return '';
  }
}
