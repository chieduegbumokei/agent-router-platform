import { describe, expect, it } from 'vitest';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../src/auth/passwords';

describe('passwords', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).not.toContain('correct horse');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong password!', hash)).toBe(false);
  });

  it('produces unique hashes (salted)', async () => {
    const [a, b] = await Promise.all([hashPassword('same-pass'), hashPassword('same-pass')]);
    expect(a).not.toBe(b);
  });

  it('dummy hash never verifies real input', async () => {
    expect(await verifyPassword('anything', DUMMY_HASH)).toBe(false);
  });
});
