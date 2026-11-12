import { expect, test } from 'vitest';

// Throwaway probe for #13: proves CI reports failure on every OS. Never merged.
test('ci failure probe', () => {
  expect(1).toBe(2);
});
