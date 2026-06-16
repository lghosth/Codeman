/**
 * @fileoverview Tests for ExternalTmuxManager safety gates and name validation.
 */
import { describe, expect, it } from 'vitest';
import { ExternalTmuxManager, MAX_EXTERNAL_NAME_LENGTH, isValidExternalName } from '../src/external-tmux-manager.js';

describe('ExternalTmuxManager', () => {
  it('returns empty/no-op results under vitest test mode', () => {
    const manager = new ExternalTmuxManager({ enabled: true });

    expect(manager.listSessions()).toEqual([]);
    expect(manager.sessionExists('my-work_1')).toBe(false);
    expect(manager.captureBuffer('my-work_1')).toBeNull();
    expect(manager.resizeWindow('my-work_1', 80, 24)).toBe(false);
  });
});

describe('isValidExternalName', () => {
  it('accepts conservative external tmux session names', () => {
    expect(isValidExternalName('my-work_1')).toBe(true);
  });

  it.each(['', 'name.with.dot', 'name:with:colon', 'bad;rm', 'bad$(cmd)', 'bad name', '../escape'])(
    'rejects unsafe session name %j',
    (name) => {
      expect(isValidExternalName(name)).toBe(false);
    }
  );

  it('rejects overlong session names', () => {
    expect(isValidExternalName('a'.repeat(MAX_EXTERNAL_NAME_LENGTH + 1))).toBe(false);
  });
});
