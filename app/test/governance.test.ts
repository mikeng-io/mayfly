import { test, expect } from 'vitest';
import { isAllowed, type AllowPolicy } from '../src/lib/governance';

const base: AllowPolicy = { allowedOwners: [], allowedRepos: [], allowAll: false };

test('fail-closed: nothing configured => not allowed', () => {
  expect(isAllowed('acme', 'app', base)).toBe(false);
});

test('allowed by owner', () => {
  expect(isAllowed('acme', 'app', { ...base, allowedOwners: ['acme'] })).toBe(true);
  expect(isAllowed('other', 'app', { ...base, allowedOwners: ['acme'] })).toBe(false);
});

test('allowed by exact owner/repo', () => {
  const p = { ...base, allowedRepos: ['acme/app'] };
  expect(isAllowed('acme', 'app', p)).toBe(true);
  expect(isAllowed('acme', 'other', p)).toBe(false);
});

test('allowAll escape hatch serves everything', () => {
  expect(isAllowed('anyone', 'anything', { ...base, allowAll: true })).toBe(true);
});

test('matching is case-insensitive', () => {
  expect(isAllowed('ACME', 'App', { ...base, allowedOwners: ['acme'] })).toBe(true);
  expect(isAllowed('Acme', 'App', { ...base, allowedRepos: ['acme/app'] })).toBe(true);
});
