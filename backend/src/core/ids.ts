import { randomUUID, randomBytes } from 'node:crypto';

export const newId = (): string => randomUUID();

/** URL-safe random secret (for refresh tokens). */
export const newSecret = (bytes = 32): string => randomBytes(bytes).toString('hex');

/** Sortable timestamp prefix for DynamoDB SKs (fixed-width epoch millis). */
export const sortableNow = (): string => String(Date.now()).padStart(15, '0');
