import * as core from '@actions/core';
import * as glob from '@actions/glob';
import * as yaml from 'yaml';
import { readFile } from 'fs/promises';
import { isString } from 'util';

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const files = core.getInput('files');
    const globber = await glob.create(files);
    const filenames = await globber.glob();
    for (const filename of filenames) {
      core.info(`Looking at ${filename}`);
      await processFile(filename);
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
  startCharacter: number;
  endCharacter: number;
}

function parseDocument(contents: string): yaml.Document | null {
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

function findTrackables(doc: yaml.Document): Trackable[] {
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
          startCharacter,
          endCharacter,
        });
      }
    },
  });

  return trackables;
}

export async function processFile(filename: string): Promise<void> {
  const contents = await readFile(filename, 'utf-8');
  const doc = parseDocument(contents);
  if (!doc) {
    return;
  }

  const trackables = findTrackables(doc);

  // FIXME use GH client to do the tracking
  // FIXME do the edit
  // FIXME write the file back
}
