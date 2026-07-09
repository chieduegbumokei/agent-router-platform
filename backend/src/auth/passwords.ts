import bcrypt from 'bcryptjs';

const COST = 10;

/**
 * Compared against when a login hits an unknown email, so response time
 * doesn't reveal whether the account exists (user-enumeration defense).
 */
export const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', COST);

export const hashPassword = (password: string): Promise<string> => bcrypt.hash(password, COST);

export const verifyPassword = (password: string, hash: string): Promise<boolean> =>
  bcrypt.compare(password, hash);
