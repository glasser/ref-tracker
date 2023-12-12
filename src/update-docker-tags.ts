import * as core from '@actions/core';
import max from 'lodash/max';
import * as yaml from 'yaml';
import { DockerRegistryClient } from './artifactRegistry';
import {
  ScalarTokenWriter,
  getStringAndScalarTokenFromMap,
  getStringValue,
  getTopLevelBlocks,
} from './yaml';

interface Trackable {
  trackMutableTag: string;
  dockerImageRepository: string;
  tag: string;
  tagScalarTokenWriter: ScalarTokenWriter;
}

export async function updateDockerTags(
  contents: string,
  dockerRegistryClient: DockerRegistryClient,
): Promise<string> {
  return core.group('Processing trackMutableTag', async () => {
    // See updateGitRefs for an explanation about our approach to parsing YAML.
    core.info('Parsing');
    const topLevelTokens = [...new yaml.Parser().parse(contents)];
    const documents = [
      ...new yaml.Composer({ keepSourceTokens: true }).compose(topLevelTokens),
    ];

    if (documents.length > 1) {
      throw new Error('Multiple documents in YAML file');
    }

    if (documents.length < 1) {
      return contents;
    }

    const document = documents[0];

    core.info('Looking for trackMutableTag');
    const trackables = findTrackables(document);

    core.info('Checking tags against Artifact Registry');
    await checkTagsAgainstArtifactRegistryAndModifyScalars(
      trackables,
      dockerRegistryClient,
    );
    core.info('Stringifying');
    return topLevelTokens
      .map((topLevelToken) => yaml.CST.stringify(topLevelToken))
      .join('');
  });
}

function findTrackables(doc: yaml.Document.Parsed): Trackable[] {
  const trackables: Trackable[] = [];

  // FIXME figure out error handling

  const { blocks, globalBlock } = getTopLevelBlocks(doc);

  let globalDockerImageRepository: string | null = null;

  if (globalBlock?.has('dockerImage')) {
    const dockerImageBlock = globalBlock.get('dockerImage');
    if (!yaml.isMap(dockerImageBlock)) {
      throw Error('Document has `global.dockerImageBlock` that is not a map');
    }
    // Read repository from 'global' (keeping it null if it's not
    // there, though throwing if it's there as non-strings).
    globalDockerImageRepository = getStringValue(
      dockerImageBlock,
      'repository',
    );
  }

  for (const [key, value] of blocks) {
    if (!value.has('dockerImage')) {
      continue;
    }
    const dockerImageBlock = value.get('dockerImage');
    if (!yaml.isMap(dockerImageBlock)) {
      throw Error(`Document has \`${key}.dockerImage\` that is not a map`);
    }

    const dockerImageRepository =
      getStringValue(dockerImageBlock, 'repository') ??
      globalDockerImageRepository;
    const trackMutableTag = getStringValue(dockerImageBlock, 'trackMutableTag');
    const tagScalarTokenAndValue = getStringAndScalarTokenFromMap(
      dockerImageBlock,
      'tag',
    );

    if (trackMutableTag && dockerImageRepository && tagScalarTokenAndValue) {
      trackables.push({
        trackMutableTag,
        dockerImageRepository,
        tag: tagScalarTokenAndValue.value,
        tagScalarTokenWriter: new ScalarTokenWriter(
          tagScalarTokenAndValue.scalarToken,
          doc.schema,
        ),
      });
    }
  }

  return trackables;
}

async function checkTagsAgainstArtifactRegistryAndModifyScalars(
  trackables: Trackable[],
  dockerRegistryClient: DockerRegistryClient,
): Promise<void> {
  for (const trackable of trackables) {
    // FIXME error handling
    const equivalentTags = await dockerRegistryClient.getAllEquivalentTags({
      dockerImageRepository: trackable.dockerImageRepository,
      tag: trackable.trackMutableTag,
    });

    const prefix = `${trackable.trackMutableTag}---`;

    const latestMatchingTag = max(
      equivalentTags.filter((t) => t.startsWith(prefix)),
    );
    if (!latestMatchingTag) {
      throw new Error(
        `No tags on ${trackable.dockerImageRepository} start with '${prefix}'`,
      );
    }

    // It's OK if the current one is null because that's what we're overwriting, but we shouldn't
    // overwrite *to* something that doesn't exist.
    core.info(
      `for image ${trackable.dockerImageRepository}:${trackable.trackMutableTag}, selecting latest label ${latestMatchingTag}`,
    );
    if (trackable.tag === latestMatchingTag) {
      core.info('(unchanged)');
    } else {
      core.info('(changed!)');
      trackable.tagScalarTokenWriter.write(latestMatchingTag);
    }
  }
}
