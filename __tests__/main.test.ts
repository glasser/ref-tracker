/**
 * Unit tests for the action's main functionality, src/main.ts
 *
 * These should be run as if the action was called from a workflow.
 * Specifically, the inputs listed in `action.yml` should be set as environment
 * variables following the pattern `INPUT_<INPUT_NAME>`.
 */

import * as main from '../src/main';
import { join } from 'path';

// Mock the GitHub Actions core library
// let infoMock: jest.SpyInstance;

describe('action', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    //infoMock = jest.spyOn(core, 'info').mockImplementation();
  });

  it('finds trackables', async () => {
    const newContents = await main.newContentsForFile(
      join(__dirname, '__fixtures__', 'sample.yaml'),
      {
        async resolveRefToSha({ ref }) {
          if (ref === 'make-it-numeric') {
            return '12345678';
          }
          return `immutable-${ref}-hooray`;
        },
        async getTreeSHAForPath({}) {
          // FIXME test cases where the tree sha does not change
          return `${Math.random()}`;
        },
      },
    );
    expect(newContents).toMatchSnapshot();
  });
});
