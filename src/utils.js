import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export function nowIso() {
  return new Date().toISOString();
}

export function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

export function resolveFrom(baseDir, value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDir, value);
}

export async function exists(targetPath) {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function truncate(value, maxLength = 5000) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n…[truncated ${value.length - maxLength} chars]`;
}

export function shellQuoteForDisplay(value) {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
