import { config } from './config';

/**
 * Operator-defined topic blacklist (config.blockedTopics / BLOCKED_TOPICS env).
 * Checked BEFORE any LLM call so blocked requests never reach the provider and
 * never cost tokens. Matching is case-insensitive on whole words/phrases, so
 * "crypto" blocks "Crypto scams?" but not "cryptography".
 */

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const patternCache = new Map<string, RegExp>();

function patternFor(topic: string): RegExp {
  let re = patternCache.get(topic);
  if (!re) {
    // Unicode-aware word boundaries: the phrase must not be embedded in a longer word.
    re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(topic)}(?![\\p{L}\\p{N}])`, 'iu');
    patternCache.set(topic, re);
  }
  return re;
}

/** Returns the first blocked topic found in `text`, or null if the text is clean. */
export function findBlockedTopic(
  text: string,
  topics: readonly string[] = config.blockedTopics,
): string | null {
  if (!text) return null;
  for (const topic of topics) {
    if (patternFor(topic).test(text)) return topic;
  }
  return null;
}
