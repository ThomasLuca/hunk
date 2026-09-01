/**
 * Hides files from a loaded review when their path matches an `--exclude` glob.
 *
 * Every input source — a VCS review, a patch, a two-file comparison — converges on one
 * `Changeset`, so exclusion runs once over the normalized file list rather than once per
 * backend: no adapter has to learn a filtering dialect, and `hunk patch` filters the same
 * way `hunk diff` does. Patterns come from `--exclude` (repeatable) and the `exclude`
 * config key; matching is deliberately gitignore-shaped, because that is the glob dialect
 * users already have in their fingers.
 *
 * Invariants:
 * - Matching is case-sensitive and works on forward-slash, repo-relative paths.
 * - A pattern without `/` matches any single path segment, so `test` hides a `test/`
 *   directory anywhere and `*.md` hides Markdown anywhere.
 * - A pattern with `/` is anchored at the changeset root, like a gitignore rule.
 * - A renamed file survives unless every path it presents (old and new) matches, so a
 *   `notes.md` -> `notes.ts` rename stays visible under `--exclude '*.md'`.
 */
import { HunkUserError } from "../run/errors";
import type { DiffFile } from "./model";

/** One compiled exclude pattern, plus the scope its shape selects. */
interface ExcludeMatcher {
  readonly regexp: RegExp;
  /** True when the pattern carries no `/` and therefore matches any single path segment. */
  readonly segmentScoped: boolean;
}

/** Regex metacharacters that must survive a glob as literal text. */
const REGEXP_SPECIAL = /[.+^$()|\\]/;

/** Normalize a path or pattern to the forward-slash, unprefixed form matching compares. */
function normalizeSeparators(value: string) {
  let normalized = value.replaceAll("\\", "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  return normalized;
}

/** Escape one literal glob character for use inside a regular expression. */
function escapeLiteral(character: string) {
  return REGEXP_SPECIAL.test(character) ? `\\${character}` : character;
}

/**
 * Translate one glob into an anchored regular expression source.
 *
 * `**` crosses directory separators and may match zero segments; `*` and `?` never cross
 * one. Braces alternate, and bracket classes pass through with `!` rewritten as `^`.
 */
function globToRegExpSource(pattern: string) {
  let source = "";
  let index = 0;
  let braceDepth = 0;

  while (index < pattern.length) {
    const character = pattern[index]!;

    // `**/` may match zero segments, so `**/*.md` also matches a root-level `a.md`.
    if (pattern.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
      continue;
    }

    // A trailing `/**` may match nothing, so `test/**` also matches `test` itself.
    if (pattern.startsWith("/**", index) && index + 3 === pattern.length) {
      source += "(?:/.*)?";
      index += 3;
      continue;
    }

    if (pattern.startsWith("**", index)) {
      source += ".*";
      index += 2;
      continue;
    }

    if (character === "*") {
      source += "[^/]*";
      index += 1;
      continue;
    }

    if (character === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }

    if (character === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close === -1) {
        source += "\\[";
        index += 1;
        continue;
      }

      const body = pattern.slice(index + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      source += `[${negated ? "^" : ""}${body.slice(negated ? 1 : 0).replaceAll("\\", "\\\\")}]`;
      index = close + 1;
      continue;
    }

    if (character === "{") {
      source += "(?:";
      braceDepth += 1;
      index += 1;
      continue;
    }

    if (character === "}" && braceDepth > 0) {
      source += ")";
      braceDepth -= 1;
      index += 1;
      continue;
    }

    if (character === "," && braceDepth > 0) {
      source += "|";
      index += 1;
      continue;
    }

    // An escape keeps the next character literal, including a glob metacharacter.
    if (character === "\\" && index + 1 < pattern.length) {
      source += escapeLiteral(pattern[index + 1]!);
      index += 2;
      continue;
    }

    source += escapeLiteral(character);
    index += 1;
  }

  // An unbalanced `{` would otherwise compile to an invalid expression.
  source += ")".repeat(braceDepth);
  return source;
}

/** Compile one user-supplied pattern, rejecting input that cannot name a path. */
function compileExcludePattern(rawPattern: string): ExcludeMatcher {
  const trimmed = rawPattern.trim();
  const normalized = normalizeSeparators(trimmed);
  // A leading `/` anchors at the changeset root even when nothing else in the pattern does.
  const rooted = normalized.startsWith("/");
  const body = (rooted ? normalized.slice(1) : normalized).replace(/\/+$/, "");

  if (body.length === 0) {
    throw new HunkUserError(`Expected a glob pattern to exclude, but got "${trimmed}".`, [
      "Pass a glob such as `--exclude '*.md'` or `--exclude 'test/**'`.",
    ]);
  }

  // A trailing `/` names a directory, which is the same thing as everything under it.
  const expanded = normalized.endsWith("/") ? `${body}/**` : body;

  return {
    regexp: new RegExp(`^${globToRegExpSource(expanded)}$`),
    segmentScoped: !rooted && !body.includes("/"),
  };
}

/** Compile every configured pattern once, returning `undefined` when nothing is excluded. */
export function compileExcludeMatchers(
  patterns: readonly string[] | undefined,
): readonly ExcludeMatcher[] | undefined {
  if (!patterns || patterns.length === 0) {
    return undefined;
  }

  return patterns.map(compileExcludePattern);
}

/** Report whether one repo-relative path matches any compiled pattern. */
export function isExcludedPath(path: string, matchers: readonly ExcludeMatcher[]) {
  const normalized = normalizeSeparators(path);
  const segments = normalized.split("/").filter((segment) => segment.length > 0);

  return matchers.some((matcher) => {
    if (matcher.regexp.test(normalized)) {
      return true;
    }

    // A segment-scoped pattern is unanchored: `test` hides `src/test/util.ts`.
    return matcher.segmentScoped && segments.some((segment) => matcher.regexp.test(segment));
  });
}

/**
 * Drop every file whose paths are all excluded.
 *
 * Renames keep both names, and a file is hidden only when the patterns cover all of them:
 * a rename out of an excluded shape is a real change the reviewer still has to see.
 */
export function filterExcludedDiffFiles(
  files: DiffFile[],
  patterns: readonly string[] | undefined,
) {
  const matchers = compileExcludeMatchers(patterns);
  if (!matchers) {
    return files;
  }

  return files.filter((file) => {
    const paths = [file.path, file.previousPath].filter(
      (path): path is string => typeof path === "string" && path.length > 0,
    );
    if (paths.length === 0) {
      return true;
    }

    return !paths.every((path) => isExcludedPath(path, matchers));
  });
}
