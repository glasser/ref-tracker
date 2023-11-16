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

type CSTScalarToken = yaml.CST.FlowScalar | yaml.CST.BlockScalar;

interface Trackable {
  trackMutableRef: string;
  repoURL: string;
  path: string;
  ref: string;
  refScalarToken: CSTScalarToken;
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

// Returns null if the value isn't there at all; throws if it's there but isn't
// a string.
function getStringValue(
  node: yaml.CST.BlockMap | yaml.CST.FlowCollection,
  key: string,
): string | null {
  const scalarToken = getScalarTokenFromMap(node, key);
  if (scalarToken === null) {
    return null;
  }
  // FIXME this can throw
  return yaml.CST.resolveAsScalar(scalarToken).value;
}

function getScalarTokenFromMap(
  node: yaml.CST.BlockMap | yaml.CST.FlowCollection,
  key: string,
): CSTScalarToken | null {
  for (const item of node.items) {
    if (!yaml.CST.isScalar(item.key)) {
      continue;
    }
    // FIXME this can throw
    const keyScalar = yaml.CST.resolveAsScalar(item.key);
    if (keyScalar.value !== key) {
      continue;
    }
    if (!yaml.CST.isScalar(item.value)) {
      throw Error(`Value associated with ${key} is not a scalar`);
    }
    return item.value;
  }
  return null;
}

export function findTrackables(doc: yaml.CST.Document): Trackable[] {
  const trackables: Trackable[] = [];

  // FIXME figure out error handling

  yaml.CST.visit(doc, ({ key, value }) => {
    if (
      !value ||
      (value.type !== 'block-map' && value.type !== 'flow-collection')
    ) {
      return;
    }

    const trackMutableRef = getStringValue(value, 'trackMutableRef');
    const repoURL = getStringValue(value, 'repoURL');
    const path = getStringValue(value, 'path');
    const refScalarToken = getScalarTokenFromMap(value, 'ref');
    const ref = refScalarToken
      ? yaml.CST.resolveAsScalar(refScalarToken).value
      : null;
    if (trackMutableRef && repoURL && path && refScalarToken && ref) {
      trackables.push({
        trackMutableRef,
        repoURL,
        path,
        ref,
        refScalarToken,
      });
    }
  });

  return trackables;
}

export async function newContentsForFile(
  filename: string,
  gitHubClient: GitHubClient,
): Promise<string | null> {
  core.info('reading');
  const contents = await readFile(filename, 'utf-8');
  core.info('parsing');
  const topLevelTokens = [...new yaml.Parser().parse(contents)];

  core.info('finding trackables');
  const trackables: Trackable[] = [];
  for (const topLevelToken of topLevelTokens) {
    if (topLevelToken.type !== 'document') {
      continue;
    }
    trackables.push(...findTrackables(topLevelToken));
  }

  core.info('updating refs');
  await updateRefsFromGitHub(trackables, gitHubClient);
  core.info('stringifying');
  return topLevelTokens.map((token) => yaml.CST.stringify(token)).join('');
}

function setStringValue(scalarToken: CSTScalarToken, value: string) {
  const alreadyQuoted =
    scalarToken.type === 'single-quoted-scalar' ||
    scalarToken.type === 'double-quoted-scalar' ||
    scalarToken.type === 'block-scalar';
  yaml.CST.setScalarValue(scalarToken, value, {
    // We're working on the CST, not the AST, so there's no schema, which means
    // that the yaml library doesn't understand the difference between (say)
    // numbers and bools and strings. So it doesn't let you say "hey, try to
    // keep this plain (unquoted), unless it looks like a number". So we're
    // going to make sure everything we write ends up quoted. That said, if it's
    // already quoted, we'll keep the quote style rather than normalizing to
    // only one style of quotes (passing `type: undefined` does that).
    type: alreadyQuoted ? undefined : 'QUOTE_SINGLE',
  });
}

export async function updateRefsFromGitHub(
  trackables: Trackable[],
  gitHubClient: GitHubClient,
): Promise<void> {
  for (const trackable of trackables) {
    // FIXME error handling
    const mutableRefCurrentSHA = await gitHubClient.resolveRefToSha({
      repoURL: trackable.repoURL,
      ref: trackable.trackMutableRef,
    });

    if (trackable.ref === trackable.trackMutableRef) {
      // The mutable ref was written down in ref too. We always want to replace
      // that with the SHA (and if we do the path-based check below we won't,
      // because they're the same). This is something that might happen when
      // you're first adding an app (ie just writing the same thing twice and
      // letting the automation "correct" it to a SHA).
      setStringValue(trackable.refScalarToken, mutableRefCurrentSHA);
      continue;
    }

    if (trackable.ref === mutableRefCurrentSHA) {
      // The thing we would write is already in the file.
      continue;
    }

    // OK, we've got a SHA that we could overwrite the current ref
    // (`trackable.ref`) with in the config file. But we don't want to do this
    // if it would be a no-op. Let's check the tree SHA
    // (https://git-scm.com/book/en/v2/Git-Internals-Git-Objects#_tree_objects)
    // at the given path to see if it has changed between `trackable.ref` and
    // the SHA we're thinking about replacing it with.
    const currentTreeSHA = await gitHubClient.getTreeSHAForPath({
      repoURL: trackable.repoURL,
      ref: trackable.ref,
      path: trackable.path,
    });
    const newTreeSHA = await gitHubClient.getTreeSHAForPath({
      repoURL: trackable.repoURL,
      ref: mutableRefCurrentSHA,
      path: trackable.path,
    });
    if (newTreeSHA === null) {
      throw Error(
        `Could not get tree SHA for ${mutableRefCurrentSHA} in ${trackable.repoURL} for ref ${trackable.path}`,
      );
    }
    // It's OK if the current one is null because that's what we're overwriting, but we shouldn't
    // overwrite *to* something that doesn't exist.
    core.info(
      `for path ${trackable.path}, got tree shas ${currentTreeSHA} for ${trackable.ref} and ${newTreeSHA} for ${mutableRefCurrentSHA}`,
    );
    if (currentTreeSHA === newTreeSHA) {
      core.info('(unchanged)');
    } else {
      core.info('(changed!)');
      setStringValue(trackable.refScalarToken, mutableRefCurrentSHA);
    }
  }
}
