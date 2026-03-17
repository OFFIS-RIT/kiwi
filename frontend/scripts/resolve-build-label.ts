// Resolves a human-readable build label from git metadata (tag or commit date).
// When running inside Docker via compose, the Makefile pre-resolves the label
// and passes it as NEXT_PUBLIC_APP_BUILD_LABEL through the container env.
// The override check below lets that value pass through without requiring git
// inside the container image.
import { execFileSync } from "node:child_process";

function runGit(args: string[]) {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const overrideLabel = process.env.NEXT_PUBLIC_APP_BUILD_LABEL?.trim();

if (overrideLabel) {
  process.stdout.write(overrideLabel);
  process.exit(0);
}

const tagLabel = runGit(["describe", "--tags", "--exact-match", "HEAD"]);
const commitDateLabel = runGit(["log", "-1", "--date=short", "--format=%cd"]);
const buildLabel = tagLabel || commitDateLabel;

if (!buildLabel) {
  console.error(
    "Unable to resolve NEXT_PUBLIC_APP_BUILD_LABEL from Git metadata."
  );
}

process.stdout.write(buildLabel);
