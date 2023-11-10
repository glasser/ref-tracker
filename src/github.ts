import { getOctokit } from '@actions/github';
import * as core from '@actions/core';

export interface ResolveRefToShaOptions {
  repoURL: string;
  ref: string;
}

export interface GitHubClient {
  resolveRefToSha(options: ResolveRefToShaOptions): Promise<string>;
}

export class OctokitGitHubClient {
  constructor(private octokit: ReturnType<typeof getOctokit>) {}

  async resolveRefToSha({
    repoURL,
    ref,
  }: ResolveRefToShaOptions): Promise<string> {
    const m = repoURL.match(
      /\bgithub\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git|\/)?$/,
    );
    if (!m) {
      throw Error(`Can only track GitHub repoURLs, not ${repoURL}`);
    }
    core.info(`owner '${m[1]}' repo '${m[2]}' ref '${ref}'`);
    const sha = (
      await this.octokit.rest.repos.getCommit({
        owner: m[1],
        repo: m[2],
        ref,
        mediaType: {
          format: 'sha',
        },
      })
    ).data as unknown;
    // TS types don't understand the effect of format: 'sha'.
    if (typeof sha !== 'string') {
      throw Error('Expected string response');
    }
    return sha;
  }
}
