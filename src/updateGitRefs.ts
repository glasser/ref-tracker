import * as core from '@actions/core';
import { CST, Parser } from 'yaml';
import { GitHubClient } from './github';

type CSTScalarToken = CST.FlowScalar | CST.BlockScalar;

interface Trackable {
  trackMutableRef: string;
  repoURL: string;
  path: string;
  ref: string;
  refScalarToken: CSTScalarToken;
}

// Returns null if the value isn't there at all; throws if it's there but isn't
// a string.
function getStringValue(
  node: CST.BlockMap | CST.FlowCollection,
  key: string,
): string | null {
  const scalarToken = getScalarTokenFromMap(node, key);
  if (scalarToken === null) {
    return null;
  }
  // FIXME this can throw
  return CST.resolveAsScalar(scalarToken).value;
}

function getScalarTokenFromMap(
  node: CST.BlockMap | CST.FlowCollection,
  key: string,
): CSTScalarToken | null {
  for (const item of node.items) {
    if (!CST.isScalar(item.key)) {
      continue;
    }
    // FIXME this can throw
    const keyScalar = CST.resolveAsScalar(item.key);
    if (keyScalar.value !== key) {
      continue;
    }
    if (!CST.isScalar(item.value)) {
      throw Error(`Value associated with ${key} is not a scalar`);
    }
    return item.value;
  }
  return null;
}

function findTrackables(doc: CST.Document): Trackable[] {
  const trackables: Trackable[] = [];

  // FIXME figure out error handling

  CST.visit(doc, ({ key, value }) => {
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
      ? CST.resolveAsScalar(refScalarToken).value
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

export async function updateGitRefs(
  contents: string,
  gitHubClient: GitHubClient,
): Promise<string> {
  return core.group('Processing trackMutableRef', async () => {
    core.info('Parsing');
    const topLevelTokens = [...new Parser().parse(contents)];

    core.info('Looking for trackMutableRef');
    const trackables = topLevelTokens.flatMap((topLevelToken) =>
      topLevelToken.type === 'document' ? findTrackables(topLevelToken) : [],
    );

    core.info('Checking refs against GitHub');
    await checkRefsAgainstGitHubAndModifyScalars(trackables, gitHubClient);
    core.info('Stringifying');
    return topLevelTokens.map((token) => CST.stringify(token)).join('');
  });
}

function setStringValue(scalarToken: CSTScalarToken, value: string) {
  const alreadyQuoted =
    scalarToken.type === 'single-quoted-scalar' ||
    scalarToken.type === 'double-quoted-scalar' ||
    scalarToken.type === 'block-scalar';
  CST.setScalarValue(scalarToken, value, {
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

async function checkRefsAgainstGitHubAndModifyScalars(
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
