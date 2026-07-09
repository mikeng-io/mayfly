import { test, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySignature } from '../src/lib/hmac';

const secret = 's3cr3t';
const body = '{"a":1}';
const good = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

test('accepts a valid signature', () => expect(verifySignature(secret, body, good)).toBe(true));
test('rejects a bad signature', () =>
  expect(verifySignature(secret, body, 'sha256=deadbeef')).toBe(false));
test('rejects a missing header', () => expect(verifySignature(secret, body, undefined)).toBe(false));
test('accepts a valid signature over a Buffer body', () => {
  const buf = Buffer.from(body);
  const sig = 'sha256=' + createHmac('sha256', secret).update(buf).digest('hex');
  expect(verifySignature(secret, buf, sig)).toBe(true);
});
test('rejects a header of a different length (no throw)', () =>
  expect(verifySignature(secret, body, 'sha256=abc')).toBe(false));
