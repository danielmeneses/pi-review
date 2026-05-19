/**
 * GitignoreMatcher — reads .gitignore from the project root and checks
 * whether a given relative path should be ignored.
 *
 * Uses the `ignore` npm package which implements the full .gitignore spec
 * (negation patterns, double-star globs, anchored patterns, etc.).
 *
 * The matcher is lazy — it only reads .gitignore on the first call to
 * isIgnored(), and caches the result for the lifetime of the process.
 * Call refresh() to re-read after the .gitignore file changes.
 */

import ignore from "ignore";
import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

export class GitignoreMatcher {
  private ig: ReturnType<typeof ignore> | null = null;
  private loaded = false;

  constructor(private cwd: string) {}

  /**
   * Check whether a file path should be ignored per .gitignore rules.
   * The path can be absolute (will be relativized to cwd) or already relative.
   */
  isIgnored(filePath: string): boolean {
    this.ensureLoaded();
    if (!this.ig) return false;

    const relPath = filePath.startsWith("/") || filePath.startsWith(this.cwd)
      ? relative(this.cwd, filePath)
      : filePath;

    return this.ig.ignores(relPath);
  }

  /**
   * Force a re-read of .gitignore (useful if the file changes at runtime).
   */
  refresh(): void {
    this.ig = null;
    this.loaded = false;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;

    const gitignorePath = join(this.cwd, ".gitignore");
    if (!existsSync(gitignorePath)) return;

    try {
      const content = readFileSync(gitignorePath, "utf8");
      this.ig = ignore().add(content);
    } catch {
      // If .gitignore can't be read, don't filter
    }
  }
}
