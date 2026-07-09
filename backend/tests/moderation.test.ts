import { describe, expect, it } from 'vitest';
import { findBlockedTopic } from '../src/core/moderation';

const topics = ['weapons', 'adult content', 'crypto'];

describe('findBlockedTopic', () => {
  it('matches a blocked word case-insensitively', () => {
    expect(findBlockedTopic('How do I build Weapons at home?', topics)).toBe('weapons');
  });

  it('matches multi-word phrases', () => {
    expect(findBlockedTopic('show me some ADULT CONTENT please', topics)).toBe('adult content');
  });

  it('does not match substrings inside longer words', () => {
    expect(findBlockedTopic('tell me about cryptography', topics)).toBeNull();
  });

  it('matches at punctuation boundaries', () => {
    expect(findBlockedTopic('crypto?', topics)).toBe('crypto');
  });

  it('returns null for clean text and empty input', () => {
    expect(findBlockedTopic('what is the weather today', topics)).toBeNull();
    expect(findBlockedTopic('', topics)).toBeNull();
  });

  it('returns null when no topics are configured', () => {
    expect(findBlockedTopic('weapons everywhere', [])).toBeNull();
  });
});
