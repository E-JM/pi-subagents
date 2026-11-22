/**
 * Two-outcome return for boundary work: parse, validate, claim. The caller has
 * to handle both branches, and the failure payload stays typed instead of
 * turning into a thrown string.
 *
 * Not every fallible call wants this: plain absence is `null`, and a broken
 * invariant in our own code should throw rather than be packed into a result.
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
