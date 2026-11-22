// Random identifiers for run ids and /tmp sentinel paths.
import { randomBytes } from "node:crypto";

/**
 * Random hex fragment, e.g. randomHex(8) -> "1a2b3c4d". Crypto-strong and always
 * exactly `count` chars, because ids feed /tmp sentinel paths where a short or
 * predictable fragment would be guessable.
 */
export function randomHex(count: number): string {
  return randomBytes(Math.ceil(count / 2))
    .toString("hex")
    .slice(0, count);
}
