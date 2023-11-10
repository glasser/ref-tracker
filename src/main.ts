import * as core from '@actions/core';
import * as github from '@actions/github';
import * as glob from '@actions/glob';
import * as yaml from 'yaml';
import { readFile, writeFile } from 'fs/promises';
import { GitHubClient, OctokitGitHubClient } from './github';

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
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

interface Trackable {
  trackMutableRef: string;
  repoURL: string;
  path: string;
  ref: string;
  newRef: string;
  startCharacter: number;
  endCharacter: number;
}

export async function processFile(
  filename: string,
  gitHubClient: GitHubClient,
): Promise<void> {
  const newContents = await newContentsForFile(filename, gitHubClient);
  if (newContents !== null) {
    await writeFile(filename, newContents);
  }
}

export function parseDocument(
  contents: string,
  filename: string,
): yaml.Document | null {
  const doc = yaml.parseDocument(contents);
  if (doc.errors.length) {
    core.error(`Errors parsing YAML file ${filename}; skipping processing`);
    for (const error of doc.errors) {
      core.error(error.message);
    }
    return null;
  }
  if (doc.warnings.length) {
    core.warning(`Warnings parsing YAML file ${filename}`);
    for (const warning of doc.warnings) {
      core.warning(warning.message);
    }
  }
  return doc;
}

export function findTrackables(doc: yaml.Document): Trackable[] {
  const trackables: Trackable[] = [];

  // FIXME figure out error handling

  yaml.visit(doc, {
    Map(_, node) {
      if (
        node.has('trackMutableRef') &&
        node.has('repoURL') &&
        node.has('path') &&
        node.has('ref')
      ) {
        const trackMutableRef = node.get('trackMutableRef');
        if (typeof trackMutableRef !== 'string') {
          throw Error(`trackMutableRef value must be a string`);
        }
        const repoURL = node.get('repoURL');
        if (typeof repoURL !== 'string') {
          throw Error(`repoURL value must be a string`);
        }
        const path = node.get('path');
        if (typeof path !== 'string') {
          throw Error(`path value must be a string`);
        }
        const refScalar = node.get('ref', true);
        if (!yaml.isScalar(refScalar)) {
          throw Error('ref value must be a scalar');
        }
        const ref = refScalar.value;
        if (typeof ref !== 'string') {
          throw Error('ref value must be a string');
        }
        if (!refScalar.range) {
          // Shouldn't happen for a Scalar created by the parser.
          throw Error('YAML for ref does not say where it lives');
        }
        const [startCharacter, endCharacter] = refScalar.range;
        trackables.push({
          trackMutableRef,
          repoURL,
          path,
          ref,
          newRef: ref,
          startCharacter,
          endCharacter,
        });
      }
    },
  });

  // Just in case we don't produce them in order, make them be in order now.
  trackables.sort((a, b) => a.startCharacter - b.startCharacter);

  return trackables;
}

export async function newContentsForFile(
  filename: string,
  gitHubClient: GitHubClient,
): Promise<string | null> {
  core.info('reading');
  const contents = await readFile(filename, 'utf-8');
  core.info('parsing');
  const doc = parseDocument(contents, filename);
  if (!doc) {
    return null;
  }

  core.info('finding trackables');
  const trackables = findTrackables(doc);
  core.info('updating refs');
  await updateRefsFromGitHub(trackables, gitHubClient);
  core.info('rewriting refs');
  return rewriteRefs(contents, trackables);
}

export async function updateRefsFromGitHub(
  trackables: Trackable[],
  gitHubClient: GitHubClient,
): Promise<void> {
  for (const trackable of trackables) {
    // FIXME error handling
    trackable.newRef = await gitHubClient.resolveRefToSha({
      repoURL: trackable.repoURL,
      ref: trackable.ref,
    });
  }
}

export function rewriteRefs(contents: string, trackables: Trackable[]): string {
  // First, let's validate that the substrings we're trying to update come in
  // order and don't overlap.
  for (const [i, trackable] of trackables.entries()) {
    if (trackable.endCharacter <= trackable.startCharacter) {
      throw Error(
        `Trackable has end ${trackable.endCharacter} that is not after start ${trackable.startCharacter}`,
      );
    }
    if (i > 0 && trackable.startCharacter < trackables[i - 1].endCharacter) {
      throw Error(
        `Trackable has start ${
          trackable.startCharacter
        } that is before previous end ${trackables[i - 1].endCharacter}`,
      );
    }
  }

  let adjustment = 0;
  for (const trackable of trackables) {
    // Wrap quotes around the ref (needed if the ref is all digits).
    const newValue = JSON.stringify(trackable.newRef);
    contents =
      contents.substring(0, trackable.startCharacter + adjustment) +
      newValue +
      contents.substring(trackable.endCharacter + adjustment);

    // If we increased the length of the part we changed, we'll need to increase
    // all the indexes we use later. If we decrease the length, we'll need to
    // decrease the indexes.
    adjustment +=
      newValue.length - (trackable.endCharacter - trackable.startCharacter);
  }

  return contents;
}
