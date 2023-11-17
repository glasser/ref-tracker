import * as core from '@actions/core';
import * as yaml from 'yaml';
import { GitHubClient } from './github';
import { CSTScalarToken, ScalarTokenWriter } from './yaml';

interface Trackable {
  trackMutableRef: string;
  repoURL: string;
  path: string;
  ref: string;
  refScalarTokenWriter: ScalarTokenWriter;
}

export async function updateGitRefs(
  contents: string,
  gitHubClient: GitHubClient,
): Promise<string> {
  return core.group('Processing trackMutableRef', async () => {
    // The yaml module lets us parse YAML into three layers of abstraction:
    // - It can create raw JS arrays/objects/etc, which is simple to dealing
    //   with but loses track of everything relating to formatting.
    // - It can create a low-level "Concrete Syntax Tree" (CST) which lets us
    //   re-create the original document with byte-by-byte accuracy, but is
    //   awkward to read from (eg, you have to navigate maps item by item rather
    //   than using keys).
    // - It can create a high-level "Abstract Syntax Tree" (AST) which is easier
    //   to read from but loses some formatting details.
    //
    // We'd prefer to read ASTs and write CSTs, and in fact the module lets us
    // do exactly that. We first create CSTs with the "Parser". We then convert
    // it into ASTs with the Composer, passing in the `keepSourceTokens` option
    // which means that every node in the AST will have a `srcToken` reference
    // to the underlying CST node that created it. When we want to make changes,
    // we do that by writing to the CST node found in a `srcToken` reference.
    // Finally, when we're done, we stringify the CSTs (which have been mutated)
    // rather than the ASTs.
    core.info('Parsing');
    const topLevelTokens = [...new yaml.Parser().parse(contents)];
    const documents = [
      ...new yaml.Composer({ keepSourceTokens: true }).compose(topLevelTokens),
    ];

    core.info('Looking for trackMutableRef');
    const trackables = documents.flatMap((document) =>
      findTrackables(document),
    );

    core.info('Checking refs against GitHub');
    await checkRefsAgainstGitHubAndModifyScalars(trackables, gitHubClient);
    core.info('Stringifying');
    return topLevelTokens
      .map((topLevelToken) => yaml.CST.stringify(topLevelToken))
      .join('');
  });
}

function findTrackables(doc: yaml.Document): Trackable[] {
  const trackables: Trackable[] = [];

  // FIXME figure out error handling

  yaml.visit(doc, {
    Map(_, value) {
      const trackMutableRef = getStringValue(value, 'trackMutableRef');
      const repoURL = getStringValue(value, 'repoURL');
      const path = getStringValue(value, 'path');
      const refScalarTokenAndValue = getStringAndScalarTokenFromMap(
        value,
        'ref',
      );
      if (trackMutableRef && repoURL && path && refScalarTokenAndValue) {
        trackables.push({
          trackMutableRef,
          repoURL,
          path,
          ref: refScalarTokenAndValue.value,
          refScalarTokenWriter: new ScalarTokenWriter(
            refScalarTokenAndValue.scalarToken,
            doc.schema,
          ),
        });
      }
    },
  });

  return trackables;
}

// Returns null if the value isn't there at all; throws if it's there but isn't
// a string.
function getStringValue(node: yaml.YAMLMap, key: string): string | null {
  return getStringAndScalarTokenFromMap(node, key)?.value ?? null;
}

// Returns null if the value isn't there at all; throws if it's there but isn't
// a string.
function getStringAndScalarTokenFromMap(
  node: yaml.YAMLMap,
  key: string,
): { scalarToken: CSTScalarToken; value: string } | null {
  if (!node.has(key)) {
    return null;
  }
  const scalar = node.get(key, true);
  if (!yaml.isScalar(scalar)) {
    throw Error(`${key} value must be a scalar`);
  }
  const scalarToken = scalar?.srcToken;
  if (!yaml.CST.isScalar(scalarToken)) {
    // this probably can't happen, but let's make the types happy
    throw Error(`${key} value must come from a scalar token`);
  }
  if (typeof scalar.value !== 'string') {
    throw Error(`${key} value must be a string`);
  }
  return { scalarToken, value: scalar.value };
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
      trackable.refScalarTokenWriter.write(mutableRefCurrentSHA);
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
      trackable.refScalarTokenWriter.write(mutableRefCurrentSHA);
    }
  }
}