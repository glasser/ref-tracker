import { getOctokit } from '@actions/github';

export interface ResolveRefToShaOptions {
  repoURL: string;
  ref: string;
}

export interface GitHubClient {
  resolveRefToSha(options: ResolveRefToShaOptions): Promise<string>;
}

export class OctokitGitHubClient {
  constructor(private octokit: ReturnType<typeof getOctokit>) {}
  async resolveRefToSha(options: ResolveRefToShaOptions): Promise<string> {
    //this.octokit.re;
    return '';
  }
}
