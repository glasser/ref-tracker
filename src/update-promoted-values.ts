import * as core from '@actions/core';
import { RE2 } from 're2-wasm';
import * as yaml from 'yaml';
import { ScalarTokenWriter, getTopLevelBlocks } from './yaml';

// FIXME we will want to make a way to filter promote-ables so that we can
// separate "promote to staging" from "promote to dev" for pipelines that have
// multiple

interface Promote {
  scalarTokenWriter: ScalarTokenWriter;
  value: string;
}

export async function updatePromotedValues(
  contents: string,
  promotionTargetRegexp: string | null,
): Promise<string> {
  return core.group('Processing promote', async () => {
    // We use re2-wasm instead of built-in RegExp so we don't have to worry about
    // REDOS attacks.
    const promotionTargetRE2 = promotionTargetRegexp
      ? new RE2(promotionTargetRegexp, 'u')
      : null;

    // See updateGitRefs for an explanation about our approach to parsing YAML.
    core.info('Parsing');
    const topLevelTokens = [...new yaml.Parser().parse(contents)];
    const documents = [
      ...new yaml.Composer({ keepSourceTokens: true }).compose(topLevelTokens),
    ];

    // We decide what to do and then we do it, just in case there are any
    // overlaps between our reads and writes.
    core.info('Looking for promote');
    const promotes = documents.flatMap((document) =>
      findPromotes(document, promotionTargetRE2),
    );

    core.info('Copying values');
    for (const { scalarTokenWriter, value } of promotes) {
      scalarTokenWriter.write(value);
    }
    core.info('Stringifying');
    return topLevelTokens
      .map((topLevelToken) => yaml.CST.stringify(topLevelToken))
      .join('');
  });
}

function findPromotes(
  document: yaml.Document.Parsed,
  promotionTargetRE2: RE2 | null,
): Promote[] {
  const { blocks } = getTopLevelBlocks(document);
  const promotes: Promote[] = [];
  for (const [myName, me] of blocks) {
    if (promotionTargetRE2 && !promotionTargetRE2.test(myName)) {
      continue;
    }
    if (!me.has('promote')) {
      continue;
    }
    const promote = me.get('promote');
    if (!yaml.isMap(promote)) {
      throw Error(`The value at ${myName}.promote must be a map`);
    }
    const from = promote.get('from');
    if (typeof from !== 'string') {
      throw Error(`The value at ${myName}.promote.from must be a string`);
    }
    const fromBlock = blocks.get(from);
    if (!fromBlock) {
      throw Error(
        `The value at ${myName}.promote.from must reference a top-level key with map value`,
      );
    }

    // FIXME use default yamlPaths
    const yamlPathsSeq = promote.get('yamlPaths');
    if (!yaml.isSeq(yamlPathsSeq)) {
      throw Error(`The value at ${myName}.promote.yamlPaths must be an array`);
    }
    const yamlPaths = yamlPathsSeq.toJSON();
    if (!Array.isArray(yamlPaths)) {
      throw Error('YAMLSeq.toJSON surprisingly did not return an array');
    }
    if (!yamlPaths.every(isCollectionPath)) {
      throw Error(
        `The value at ${myName}.promote.yamlPaths must be an array whose elements are arrays of strings or numbers`,
      );
    }

    for (const collectionPath of yamlPaths) {
      const sourceValue = fromBlock.getIn(collectionPath);
      if (typeof sourceValue !== 'string') {
        throw Error(`Could not promote from ${[from, ...collectionPath]}`);
      }
      // true means keepScalar, ie get the scalar node to write.
      const targetNode = me.getIn(collectionPath, true);
      if (!yaml.isScalar(targetNode)) {
        throw Error(`Could not promote to ${[myName, ...collectionPath]}`);
      }
      const scalarToken = targetNode.srcToken;
      if (!yaml.CST.isScalar(scalarToken)) {
        // this probably can't happen, but let's make the types happy
        throw Error(
          `${[myName, ...collectionPath]} value must come from a scalar token`,
        );
      }
      promotes.push({
        scalarTokenWriter: new ScalarTokenWriter(scalarToken, document.schema),
        value: sourceValue,
      });
    }
  }
  return promotes;
}

type CollectionPath = CollectionIndex[];
type CollectionIndex = string | number;

function isCollectionPath(value: unknown): value is CollectionPath {
  return Array.isArray(value) && value.every(isCollectionIndex);
}

function isCollectionIndex(value: unknown): value is CollectionIndex {
  return typeof value === 'string' || typeof value === 'number';
}
