import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEY_LEN = 64;
const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(String(password), salt, KEY_LEN, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, saltEncoded, hashEncoded] = String(stored || "").split("$");
    if (scheme !== "scrypt" || !saltEncoded || !hashEncoded) return false;
    const expected = Buffer.from(hashEncoded, "base64");
    if (expected.length !== KEY_LEN) return false;
    const actual = await scryptAsync(String(password), Buffer.from(saltEncoded, "base64"), KEY_LEN, SCRYPT);
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
