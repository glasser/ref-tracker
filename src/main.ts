import * as core from '@actions/core';
import * as github from '@actions/github';
import * as glob from '@actions/glob';
import { readFile, writeFile } from 'fs/promises';
import { GitHubClient, OctokitGitHubClient } from './github';
import { updateGitRefs } from './update-git-refs';
import { updatePromotedValues } from './update-promoted-values';

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function main(): Promise<void> {
  try {
    const githubToken = core.getInput('github-token');
    const octokit = github.getOctokit(githubToken);
    // FIXME consider adding @octokit/plugin-throttling
    const gitHubClient = new OctokitGitHubClient(octokit);
    const files = core.getInput('files');
    const globber = await glob.create(files);
    const filenames = await globber.glob();
    for (const filename of filenames) {
      core.info(`Looking at ${filename}`);
      await processFile(filename, gitHubClient);
    }
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message);
  }
}

export async function processFile(
  filename: string,
  gitHubClient: GitHubClient,
): Promise<void> {
  return core.group(`Processing ${filename}`, async () => {
    core.info('Reading');
    let contents = await readFile(filename, 'utf-8');

    if (core.getBooleanInput('update-git-refs')) {
      contents = await updateGitRefs(contents, gitHubClient);
    }

    if (core.getBooleanInput('update-promoted-values')) {
      contents = await updatePromotedValues(
        contents,
        core.getInput('promotion-target-regexp') || null,
      );
    }

    await writeFile(filename, contents);
  });
}
