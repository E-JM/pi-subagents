import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPlainObject } from "../guards.ts";

const DEFAULT_STATUS_LINE_LIMIT = 4;

// pi-extension/subagents/status/ -> package root (where config.json lives).
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_STATUS_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const STATUS_CONFIG_EXAMPLE_PATH = join(PACKAGE_ROOT, "config.json.example");

interface StatusConfig {
  enabled: boolean;
  lineLimit: number;
}

function invalidStatusConfig(source: string, message: string): never {
  throw new Error(`Invalid subagent status config in ${source}: ${message}`);
}

function requireObject(
  value: unknown,
  source: string,
  fieldName: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    invalidStatusConfig(source, `${fieldName} must be an object`);
  }
  return value;
}

function requireBoolean(
  value: unknown,
  source: string,
  fieldName: string,
): boolean {
  if (typeof value !== "boolean") {
    invalidStatusConfig(source, `${fieldName} must be a boolean`);
  }
  return value;
}

function rejectUnsupportedKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  source: string,
  fieldName: string,
): void {
  const unsupportedKeys = Object.keys(value).filter(
    (key) => !allowedKeys.includes(key),
  );
  if (unsupportedKeys.length > 0) {
    invalidStatusConfig(
      source,
      `${fieldName} has unsupported key(s): ${unsupportedKeys.join(", ")}`,
    );
  }
}

export function parseStatusConfig(
  rawConfig: unknown,
  source = "config.json",
): StatusConfig {
  const config = requireObject(rawConfig, source, "root");
  // Strict at the root too: a typo'd key must not silently disable behavior.
  const unsupportedKeys = Object.keys(config).filter((key) => key !== "status");
  if (unsupportedKeys.length > 0) {
    invalidStatusConfig(
      source,
      `root has unsupported key(s): ${unsupportedKeys.join(", ")}`,
    );
  }
  const status = requireObject(config.status, source, "status");
  rejectUnsupportedKeys(status, ["enabled"], source, "status");
  const enabled = requireBoolean(status.enabled, source, "status.enabled");

  return {
    enabled,
    lineLimit: DEFAULT_STATUS_LINE_LIMIT,
  };
}

function readStatusConfigFile(
  configPath: string,
  examplePath: string,
): { sourcePath: string; rawConfig: string } {
  try {
    return {
      sourcePath: configPath,
      rawConfig: readFileSync(configPath, "utf8"),
    };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") throw error;
  }

  try {
    return {
      sourcePath: examplePath,
      rawConfig: readFileSync(examplePath, "utf8"),
    };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      throw new Error(
        `Missing subagent status config. Expected ${configPath} or ${examplePath}.`,
      );
    }
    throw error;
  }
}

export function loadStatusConfig(
  configPath = DEFAULT_STATUS_CONFIG_PATH,
  examplePath = STATUS_CONFIG_EXAMPLE_PATH,
): StatusConfig {
  const { sourcePath, rawConfig } = readStatusConfigFile(
    configPath,
    examplePath,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`);
  }

  return parseStatusConfig(parsed, sourcePath);
}
