import { describe, expect, it } from 'vitest';
import { pollDelay } from './poll';

describe('pollDelay', () => {
  it('starts at ~2 s and backs off to a 5 s ceiling', () => {
    expect(pollDelay(0)).toBe(2000);
    expect(pollDelay(1)).toBe(2500);
    const seq = Array.from({ length: 12 }, (_, i) => pollDelay(i));
    expect(seq.every((d, i) => i === 0 || d >= seq[i - 1])).toBe(true);
    expect(Math.max(...seq)).toBe(5000);
    expect(pollDelay(-3)).toBe(2000);
  });
});
