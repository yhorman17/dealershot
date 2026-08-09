import { randomInt } from "node:crypto";

const UPPERCASE = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWERCASE = "abcdefghijkmnopqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%*-_+";
const ALL = `${UPPERCASE}${LOWERCASE}${DIGITS}${SYMBOLS}`;

function pick(alphabet: string) {
  return alphabet[randomInt(alphabet.length)];
}

/**
 * Creates a cryptographically random, unambiguous temporary password.
 * The value must remain in server memory and be returned only once.
 */
export function generateTemporaryPassword(length = 20) {
  if (!Number.isInteger(length) || length < 16 || length > 128) {
    throw new Error("Temporary passwords must be between 16 and 128 characters.");
  }

  const characters = [pick(UPPERCASE), pick(LOWERCASE), pick(DIGITS), pick(SYMBOLS)];
  while (characters.length < length) characters.push(pick(ALL));

  for (let index = characters.length - 1; index > 0; index--) {
    const swapWith = randomInt(index + 1);
    [characters[index], characters[swapWith]] = [characters[swapWith], characters[index]];
  }

  return characters.join("");
}

export function isValidTemporaryPassword(password: string) {
  return (
    password.length >= 16 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[!@#$%*\-_+]/.test(password)
  );
}
