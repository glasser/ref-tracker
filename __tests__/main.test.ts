/**
 * Unit tests for the action's main functionality, src/main.ts
 *
 * These should be run as if the action was called from a workflow.
 * Specifically, the inputs listed in `action.yml` should be set as environment
 * variables following the pattern `INPUT_<INPUT_NAME>`.
 */

import * as core from '@actions/core';
import * as main from '../src/main';
import { join } from 'path';

// Mock the GitHub Actions core library
let infoMock: jest.SpyInstance;

describe('action', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    infoMock = jest.spyOn(core, 'info').mockImplementation();
  });

  it('processes a file', async () => {
    await main.processFile(join(__dirname, '__fixtures__', 'sample.yaml'));
    expect(infoMock).toHaveBeenNthCalledWith(
      1,
      'path: some-service-dev0.source',
    );
    expect(infoMock).toHaveBeenNthCalledWith(
      2,
      'path: some-service-staging.source',
    );
  });
});
