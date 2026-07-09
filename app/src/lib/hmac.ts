import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a GitHub `X-Hub-Signature-256` header against the raw request body.
 * Constant-time compare; returns false (never throws) on any malformed input.
 */
export function verifySignature(
  secret: string,
  rawBody: Buffer | string,
  header?: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
