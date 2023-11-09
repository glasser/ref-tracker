/**
 * Unit tests for the action's main functionality, src/main.ts
 *
 * These should be run as if the action was called from a workflow.
 * Specifically, the inputs listed in `action.yml` should be set as environment
 * variables following the pattern `INPUT_<INPUT_NAME>`.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { GitHubClient } from '../src/github';
import { updateGitRefs } from '../src/update-git-refs';

// FIXME figure out logging (eg pass in a fake implementation of core
// to code, or mock it, or capture process.stdout, etc)
// Mock the GitHub Actions core library
// let infoMock: jest.SpyInstance;

describe('action', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    //infoMock = jest.spyOn(core, 'info').mockImplementation();
  });

  it('updates git refs', async () => {
    const contents = await readFile(
      join(__dirname, '__fixtures__', 'update-git-refs', 'sample.yaml'),
      'utf-8',
    );
    const mockGitHubClient: GitHubClient = {
      async resolveRefToSha({ ref }) {
        if (ref === 'make-it-numeric') {
          return '12345678';
        }
        return `immutable-${ref}-hooray`;
      },
      async getTreeSHAForPath() {
        // FIXME test cases where the tree sha does not change
        return `${Math.random()}`;
      },
    };

    const newContents = await updateGitRefs(contents, mockGitHubClient);
    expect(newContents).toMatchSnapshot();

    // It should be idempotent in this case.
    expect(await updateGitRefs(newContents, mockGitHubClient)).toBe(
      newContents,
    );
  });
});
