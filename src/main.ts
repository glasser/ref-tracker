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

// interface ConfigNode {
//   pathInConfigFile: string[];
//   repoURL: string;
//   path: string;
//   trackMutableRef: string;
// }

export async function processFile(filename: string): Promise<void> {
  const contents = await readFile(filename, 'utf-8');
  const doc = yaml.parseDocument(contents);
  if (doc.errors.length) {
    core.error(`Errors parsing YAML file ${filename}; skipping processing`);
    for (const error of doc.errors) {
      core.error(error.message);
    }
    return;
  }
  if (doc.warnings.length) {
    core.warning(`Warnings parsing YAML file ${filename}`);
    for (const warning of doc.warnings) {
      core.warning(warning.message);
    }
  }

  yaml.visit(doc, {
    Map(_, node, ancestry) {
      if (
        node.has('trackMutableRef') &&
        node.has('repoURL') &&
        node.has('path')
      ) {
        const pathInConfigFile = ancestry
          .filter(yaml.isPair)
          .map((pair) => pair.key)
          .filter(yaml.isScalar)
          .map((scalar) => scalar.value)
          .filter(isString);
        core.info(`path: ${pathInConfigFile.join('.')}`);
      }
    },
  });
}
