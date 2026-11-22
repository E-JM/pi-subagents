import { existsSync, readFileSync } from "node:fs";
import { Value } from "@sinclair/typebox/value";
import { isPlainObject } from "../guards.ts";
import { err, ok } from "../result.ts";
import { type ActivityReadResult, SubagentActivitySchema } from "./schema.ts";

export function readSubagentActivityFile(
  activityFile: string,
  expectedRunningChildId: string,
): ActivityReadResult {
  if (!existsSync(activityFile)) return err({ kind: "missing" });

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(activityFile, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err({ kind: "invalid", message });
  }

  return validateActivity(parsed, expectedRunningChildId);
}

/** Child-written, so nothing is trusted until the schema accepts it. */
function validateActivity(
  value: unknown,
  expectedRunningChildId: string,
): ActivityReadResult {
  if (!isPlainObject(value)) {
    return err({ kind: "invalid", message: "activity must be an object" });
  }

  // Valid but from another child: not corrupt, so not "invalid".
  const runningChildId = value.runningChildId;
  if (
    typeof runningChildId === "string" &&
    runningChildId !== expectedRunningChildId
  ) {
    return err({ kind: "wrong-id" });
  }

  if (!Value.Check(SubagentActivitySchema, value)) {
    return err({ kind: "invalid", message: firstProblem(value) });
  }
  return ok(Value.Decode(SubagentActivitySchema, value));
}

/** First schema violation as `field: expected ...`, for the parent's log. */
function firstProblem(value: unknown): string {
  const problem = Value.Errors(SubagentActivitySchema, value).First();
  if (!problem) return "activity does not match the snapshot schema";
  const field =
    problem.path.replace(/^\//, "").replace(/\//g, ".") || "activity";
  return `${field}: ${problem.message}`;
}
