/**
 * Customizable keyboard shortcuts. Bindings are a device-local preference
 * (Mac vs PC keyboards differ), so they live in localStorage next to the
 * other UI prefs. `mod` means "the primary modifier" - ⌘ on Mac OR Ctrl
 * anywhere - so defaults work on both without per-platform storage.
 */

export type ShortcutAction = 'search' | 'newChat' | 'incognito';

export interface ShortcutBinding {
  /** KeyboardEvent.key, single chars lowercased ("k", "F2", "ArrowUp") */
  key: string;
  /** ⌘ or Ctrl */
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

export type ShortcutMap = Record<ShortcutAction, ShortcutBinding>;

export const SHORTCUT_ACTIONS: Array<{ id: ShortcutAction; label: string }> = [
  { id: 'search', label: 'Search conversations' },
  { id: 'newChat', label: 'New chat' },
  { id: 'incognito', label: 'Toggle incognito chat' },
];

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  search: { key: 'k', mod: true, shift: false, alt: false },
  newChat: { key: 'o', mod: true, shift: true, alt: false },
  incognito: { key: 'i', mod: true, shift: true, alt: false },
};

const STORAGE_KEY = 'assistant.shortcuts';

/** Non-rebindable keys: reserved by the composer, menus, and stop-generation. */
const RESERVED_KEYS = new Set(['escape', 'enter', 'tab', 'backspace', 'delete', ' ']);

export function loadShortcuts(): ShortcutMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SHORTCUTS;
    const parsed = JSON.parse(raw) as Partial<Record<ShortcutAction, ShortcutBinding>>;
    // merge over defaults so newly added actions keep working
    const merged = { ...DEFAULT_SHORTCUTS };
    for (const { id } of SHORTCUT_ACTIONS) {
      const b = parsed[id];
      if (b && typeof b.key === 'string' && b.key.length > 0) {
        merged[id] = { key: b.key, mod: !!b.mod, shift: !!b.shift, alt: !!b.alt };
      }
    }
    return merged;
  } catch {
    return DEFAULT_SHORTCUTS;
  }
}

export function saveShortcuts(map: ShortcutMap): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

/** Event → binding; null while only modifiers are held down. */
export function bindingFromEvent(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): ShortcutBinding | null {
  // `key` can be undefined for synthetic events (e.g. Chrome autofill, IME composition).
  if (!e.key) return null;
  if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt') return null;
  return {
    key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
    mod: e.metaKey || e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
  };
}

/** Human-readable reason a binding is not usable, or null when it is fine. */
export function validateBinding(b: ShortcutBinding): string | null {
  if (RESERVED_KEYS.has(b.key.toLowerCase())) {
    return 'That key is reserved (composer and stop/close use it)';
  }
  const isFunctionKey = /^F\d{1,2}$/.test(b.key);
  if (!b.mod && !b.alt && !isFunctionKey) {
    return 'Add ⌘/Ctrl or Alt so normal typing is not hijacked';
  }
  return null;
}

export const sameBinding = (a: ShortcutBinding, b: ShortcutBinding): boolean =>
  a.key === b.key && a.mod === b.mod && a.shift === b.shift && a.alt === b.alt;

export function matchesBinding(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  b: ShortcutBinding,
): boolean {
  // `key` can be undefined for synthetic events (e.g. Chrome autofill, IME composition).
  if (!e.key) return false;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return (
    key === b.key &&
    (e.metaKey || e.ctrlKey) === b.mod &&
    e.shiftKey === b.shift &&
    e.altKey === b.alt
  );
}

const isMac = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

const KEY_GLYPHS: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
};

export function formatBinding(b: ShortcutBinding): string {
  const keyLabel = KEY_GLYPHS[b.key] ?? (b.key.length === 1 ? b.key.toUpperCase() : b.key);
  if (isMac()) {
    return `${b.mod ? '⌘' : ''}${b.alt ? '⌥' : ''}${b.shift ? '⇧' : ''}${keyLabel}`;
  }
  return [b.mod ? 'Ctrl' : '', b.alt ? 'Alt' : '', b.shift ? 'Shift' : '', keyLabel]
    .filter(Boolean)
    .join('+');
}
