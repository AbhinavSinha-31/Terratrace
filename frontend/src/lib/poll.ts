/** Delay before poll number `n` (0-based) of a running job: ~2 s, backing off ×1.25 per poll to at most 5 s. */
export const pollDelay = (n: number) => Math.min(5000, Math.round(2000 * 1.25 ** Math.max(0, n)));
