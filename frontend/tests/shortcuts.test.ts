import { beforeEach, describe, expect, it } from 'vitest';
import {
  bindingFromEvent,
  DEFAULT_SHORTCUTS,
  loadShortcuts,
  matchesBinding,
  sameBinding,
  saveShortcuts,
  validateBinding,
} from '../src/lib/shortcuts';

const key = (over: Partial<KeyboardEvent>) => ({
  key: 'k',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

beforeEach(() => localStorage.clear());

describe('binding capture', () => {
  it('ignores modifier-only presses and lowercases single chars', () => {
    expect(bindingFromEvent(key({ key: 'Meta', metaKey: true }))).toBeNull();
    expect(bindingFromEvent(key({ key: 'Shift', shiftKey: true }))).toBeNull();
    expect(bindingFromEvent(key({ key: 'K', metaKey: true, shiftKey: true }))).toEqual({
      key: 'k',
      mod: true,
      shift: true,
      alt: false,
    });
  });

  it('treats ⌘ and Ctrl as the same primary modifier', () => {
    const fromMac = bindingFromEvent(key({ key: 'k', metaKey: true }))!;
    const fromPc = key({ key: 'k', ctrlKey: true });
    expect(matchesBinding(fromPc, fromMac)).toBe(true);
  });
});

describe('binding validation', () => {
  it('requires a modifier for plain character keys', () => {
    expect(validateBinding({ key: 'k', mod: false, shift: false, alt: false })).toMatch(/modifier|⌘/i);
    expect(validateBinding({ key: 'k', mod: true, shift: false, alt: false })).toBeNull();
    expect(validateBinding({ key: 'k', mod: false, shift: false, alt: true })).toBeNull();
  });

  it('allows bare function keys but never reserved keys', () => {
    expect(validateBinding({ key: 'F2', mod: false, shift: false, alt: false })).toBeNull();
    expect(validateBinding({ key: 'Enter', mod: true, shift: false, alt: false })).toMatch(/reserved/i);
    expect(validateBinding({ key: 'Escape', mod: true, shift: false, alt: false })).toMatch(/reserved/i);
  });
});

describe('matching', () => {
  it('matches only when key and every modifier line up', () => {
    const b = DEFAULT_SHORTCUTS.newChat; // mod+shift+o
    expect(matchesBinding(key({ key: 'O', metaKey: true, shiftKey: true }), b)).toBe(true);
    expect(matchesBinding(key({ key: 'o', ctrlKey: true, shiftKey: true }), b)).toBe(true);
    expect(matchesBinding(key({ key: 'o', metaKey: true }), b)).toBe(false); // shift missing
    expect(matchesBinding(key({ key: 'o', shiftKey: true }), b)).toBe(false); // mod missing
    expect(matchesBinding(key({ key: 'o', metaKey: true, shiftKey: true, altKey: true }), b)).toBe(false);
  });

  it('detects duplicates with sameBinding', () => {
    expect(sameBinding(DEFAULT_SHORTCUTS.search, { ...DEFAULT_SHORTCUTS.search })).toBe(true);
    expect(sameBinding(DEFAULT_SHORTCUTS.search, DEFAULT_SHORTCUTS.newChat)).toBe(false);
  });
});

describe('persistence', () => {
  it('round-trips custom bindings and merges over defaults', () => {
    const custom = { ...DEFAULT_SHORTCUTS, search: { key: 'p', mod: true, shift: false, alt: false } };
    saveShortcuts(custom);
    const loaded = loadShortcuts();
    expect(loaded.search.key).toBe('p');
    expect(loaded.newChat).toEqual(DEFAULT_SHORTCUTS.newChat);
  });

  it('falls back to defaults on corrupt or partial storage', () => {
    localStorage.setItem('assistant.shortcuts', 'not-json{');
    expect(loadShortcuts()).toEqual(DEFAULT_SHORTCUTS);
    localStorage.setItem('assistant.shortcuts', JSON.stringify({ search: { key: '' } }));
    expect(loadShortcuts().search).toEqual(DEFAULT_SHORTCUTS.search);
  });
});
