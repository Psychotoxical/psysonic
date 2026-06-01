import type { KeyboardEvent, MouseEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  handleLiveSearchScopeBackspace,
  handleLiveSearchScopeBadgeDoubleClick,
  handleLiveSearchScopeUndo,
  isLiveSearchDropdownBlocked,
  liveSearchScopePlaceholderKey,
} from './liveSearchScopeUi';

function keyEvent(
  key: string,
  mods: Partial<KeyboardEvent<HTMLInputElement>> & { code?: string } = {},
) {
  const { code, ...rest } = mods;
  return {
    key,
    code: code ?? key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...rest,
  } as unknown as KeyboardEvent<HTMLInputElement>;
}

describe('handleLiveSearchScopeBackspace', () => {
  it('clears scope only when the field is already empty', () => {
    const clearScope = vi.fn();
    const e = keyEvent('Backspace');
    expect(handleLiveSearchScopeBackspace(e, '', 'artists', clearScope)).toBe(true);
    expect(clearScope).toHaveBeenCalledWith({ recordUndo: true });
  });

  it('does not clear scope when text remains', () => {
    const clearScope = vi.fn();
    expect(handleLiveSearchScopeBackspace(keyEvent('Backspace'), 'a', 'artists', clearScope)).toBe(false);
    expect(handleLiveSearchScopeBackspace(keyEvent('Backspace'), 'ab', 'artists', clearScope)).toBe(false);
    expect(clearScope).not.toHaveBeenCalled();
  });
});

describe('isLiveSearchDropdownBlocked', () => {
  it('blocks dropdown when a browse scope badge is active', () => {
    expect(isLiveSearchDropdownBlocked('artists')).toBe(true);
    expect(isLiveSearchDropdownBlocked(null)).toBe(false);
  });
});

describe('liveSearchScopePlaceholderKey', () => {
  it('uses artists placeholder when scoped to artists', () => {
    expect(liveSearchScopePlaceholderKey('artists')).toBe('search.scopeArtistsPlaceholder');
    expect(liveSearchScopePlaceholderKey(null)).toBe('search.placeholder');
  });
});

describe('handleLiveSearchScopeBadgeDoubleClick', () => {
  it('clears scope with undo', () => {
    const clearScope = vi.fn();
    const e = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as MouseEvent<HTMLElement>;
    handleLiveSearchScopeBadgeDoubleClick(e, clearScope);
    expect(clearScope).toHaveBeenCalledWith({ recordUndo: true });
  });
});

describe('handleLiveSearchScopeUndo', () => {
  it('calls undo on Ctrl+Z (English layout)', () => {
    const undo = vi.fn(() => true);
    const e = keyEvent('z', { ctrlKey: true, code: 'KeyZ' });
    expect(handleLiveSearchScopeUndo(e, undo)).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(undo).toHaveBeenCalled();
  });

  it('calls undo on Ctrl+Z with non-Latin key label (e.g. Russian Я)', () => {
    const undo = vi.fn(() => true);
    const e = keyEvent('я', { ctrlKey: true, code: 'KeyZ' });
    expect(handleLiveSearchScopeUndo(e, undo)).toBe(true);
    expect(undo).toHaveBeenCalled();
  });

  it('ignores plain z', () => {
    const undo = vi.fn();
    expect(handleLiveSearchScopeUndo(keyEvent('z'), undo)).toBe(false);
    expect(undo).not.toHaveBeenCalled();
  });
});
