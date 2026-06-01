import type { KeyboardEvent, MouseEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  createLiveSearchScopeBackspaceState,
  handleLiveSearchScopeBackspace,
  handleLiveSearchScopeBadgeDoubleClick,
  handleLiveSearchScopeUndo,
  isLiveSearchDropdownBlocked,
  liveSearchScopePlaceholderKey,
  noteLiveSearchScopeQueryInput,
  resetLiveSearchScopeBackspaceState,
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
  it('clears scope on first Backspace when the field was never filled', () => {
    const clearScope = vi.fn();
    const state = createLiveSearchScopeBackspaceState();
    const e = keyEvent('Backspace');
    expect(handleLiveSearchScopeBackspace(e, '', 'artists', clearScope, state)).toBe(true);
    expect(clearScope).toHaveBeenCalledWith({ recordUndo: true });
  });

  it('requires two Backspaces on empty after prior input', () => {
    const clearScope = vi.fn();
    const state = createLiveSearchScopeBackspaceState();
    noteLiveSearchScopeQueryInput(state, 'ab');

    const first = keyEvent('Backspace');
    expect(handleLiveSearchScopeBackspace(first, '', 'artists', clearScope, state)).toBe(true);
    expect(clearScope).not.toHaveBeenCalled();

    const second = keyEvent('Backspace');
    expect(handleLiveSearchScopeBackspace(second, '', 'artists', clearScope, state)).toBe(true);
    expect(clearScope).toHaveBeenCalledWith({ recordUndo: true });
  });

  it('does not clear scope while text remains', () => {
    const clearScope = vi.fn();
    const state = createLiveSearchScopeBackspaceState();
    expect(handleLiveSearchScopeBackspace(keyEvent('Backspace'), 'a', 'artists', clearScope, state)).toBe(false);
    expect(clearScope).not.toHaveBeenCalled();
  });

  it('resets empty streak when deleting characters', () => {
    const clearScope = vi.fn();
    const state = createLiveSearchScopeBackspaceState();
    noteLiveSearchScopeQueryInput(state, 'a');
    handleLiveSearchScopeBackspace(keyEvent('Backspace'), '', 'artists', clearScope, state);
    expect(state.emptyBackspaceStreak).toBe(1);
    handleLiveSearchScopeBackspace(keyEvent('Backspace'), 'x', 'artists', clearScope, state);
    expect(state.emptyBackspaceStreak).toBe(0);
  });
});

describe('resetLiveSearchScopeBackspaceState', () => {
  it('clears hadQueryInput and streak', () => {
    const state = createLiveSearchScopeBackspaceState();
    noteLiveSearchScopeQueryInput(state, 'x');
    state.emptyBackspaceStreak = 1;
    resetLiveSearchScopeBackspaceState(state);
    expect(state.hadQueryInput).toBe(false);
    expect(state.emptyBackspaceStreak).toBe(0);
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
