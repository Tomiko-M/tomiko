/** The little of git that `tomiko diff` and `tomiko scan` need, through the git command line. */
import { execFile } from "node:child_process";

export class GitError extends Error {}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      // Paths come back unquoted, whatever script they are in.
      ["-c", "core.quotepath=off", ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 1 << 30,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        if (error) reject(new GitError(stderr.trim() || error.message));
        else resolve(stdout);
      },
    );
  });
}

/** The top of the work tree `cwd` is in, or undefined outside a repository or without git. */
export async function repoRoot(cwd: string): Promise<string | undefined> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return undefined;
  }
}

export interface Revision {
  ref: string;
  /** Abbreviated commit hash. */
  short: string;
}

export async function resolveRevision(cwd: string, ref: string): Promise<Revision> {
  try {
    const short = (await git(cwd, ["rev-parse", "--verify", "--quiet", "--short", `${ref}^{commit}`])).trim();
    if (short) return { ref, short };
  } catch {
    // Reported below.
  }
  throw new GitError(`Unknown git revision: ${ref}`);
}

export interface ChangedFile {
  /** Relative to the repository root, with forward slashes. */
  path: string;
  status: "added" | "modified" | "deleted";
}

const STATUS: Record<string, ChangedFile["status"]> = { A: "added", M: "modified", D: "deleted", T: "modified" };

/**
 * Files under `pathspecs` that differ between `ref` and the work tree, staged or not, plus new
 * files git doesn't track yet.
 */
export async function changedFiles(cwd: string, ref: string, pathspecs: string[]): Promise<ChangedFile[]> {
  const files = new Map<string, ChangedFile>();
  const diff = (await git(cwd, ["diff", "--name-status", "--no-renames", "-z", ref, "--", ...pathspecs])).split("\0");
  for (let i = 0; i + 1 < diff.length; i += 2) {
    const status = STATUS[diff[i]![0]!];
    if (status) files.set(diff[i + 1]!, { path: diff[i + 1]!, status });
  }
  // ls-files prints paths relative to cwd; diff prints them relative to the root.
  const prefix = (await git(cwd, ["rev-parse", "--show-prefix"])).trim();
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspecs]);
  for (const path of untracked.split("\0").filter(Boolean)) files.set(prefix + path, { path: prefix + path, status: "added" });
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** A file's content at `ref`, or undefined when it doesn't exist there. */
export async function readAt(cwd: string, ref: string, path: string): Promise<string | undefined> {
  try {
    return await git(cwd, ["cat-file", "blob", `${ref}:${path}`]);
  } catch {
    return undefined;
  }
}
