/**
 * Unit tests for the action's main functionality, src/main.ts
 *
 * These should be run as if the action was called from a workflow.
 * Specifically, the inputs listed in `action.yml` should be set as environment
 * variables following the pattern `INPUT_<INPUT_NAME>`.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { updatePromotedValues } from '../src/update-promoted-values';

// FIXME figure out logging (eg pass in a fake implementation of core
// to code, or mock it, or capture process.stdout, etc)
// Mock the GitHub Actions core library
// let infoMock: jest.SpyInstance;

async function fixture(filename: string): Promise<string> {
  return await readFile(
    join(__dirname, '__fixtures__', 'update-promoted-values', filename),
    'utf-8',
  );
}

describe('action', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    //infoMock = jest.spyOn(core, 'info').mockImplementation();
  });

  it('updates git refs', async () => {
    const contents = await fixture('sample.yaml');
    const newContents = await updatePromotedValues(contents, 'prod');
    expect(newContents).toMatchSnapshot();

    // It should be idempotent in this case.
    expect(await updatePromotedValues(newContents, 'prod')).toBe(newContents);
  });

  it('respects defaults and explicit specifications for yamlPaths', async () => {
    expect(
      await updatePromotedValues(
        await fixture('yaml-paths-defaults.yaml'),
        null,
      ),
    ).toMatchSnapshot();
  });

  it('throws if no default yamlPaths entry works', async () => {
    const contents = await fixture('default-fails.yaml');
    await expect(updatePromotedValues(contents, null)).rejects.toThrow(
      'none of the default promoted paths',
    );
  });
});
