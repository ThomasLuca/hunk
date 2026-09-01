import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../test/helpers/diff-helpers";
import { compileExcludeMatchers, filterExcludedDiffFiles, isExcludedPath } from "./excludeFilter";

/** Match one path against one pattern through the compiled-matcher entry points. */
function matches(pattern: string, path: string) {
  return isExcludedPath(path, compileExcludeMatchers([pattern])!);
}

describe("isExcludedPath", () => {
  test("matches a segment-scoped extension glob at any depth", () => {
    expect(matches("*.md", "README.md")).toBe(true);
    expect(matches("*.md", "docs/guide/intro.md")).toBe(true);
    expect(matches("*.md", "src/app.ts")).toBe(false);
  });

  test("matches a bare directory name anywhere, like a gitignore rule", () => {
    expect(matches("test", "src/test/util.ts")).toBe(true);
    expect(matches("test", "test")).toBe(true);
    expect(matches("test", "src/tests/util.ts")).toBe(false);
  });

  test("treats a trailing slash as everything under that directory", () => {
    expect(matches("test/", "src/test/util.ts")).toBe(true);
    expect(matches("docs/", "docs/a/b.md")).toBe(true);
  });

  test("anchors a pattern that contains a slash at the changeset root", () => {
    expect(matches("test/**", "test/a/b.ts")).toBe(true);
    expect(matches("test/**", "test")).toBe(true);
    expect(matches("test/**", "src/test/a.ts")).toBe(false);
  });

  test("anchors a leading-slash pattern even without an inner slash", () => {
    expect(matches("/docs", "docs")).toBe(true);
    expect(matches("/docs", "src/docs")).toBe(false);
  });

  test("lets `**` cross separators and match zero segments", () => {
    expect(matches("src/**/*.ts", "src/app.ts")).toBe(true);
    expect(matches("src/**/*.ts", "src/ui/diff/rows.ts")).toBe(true);
    expect(matches("src/**/*.ts", "lib/app.ts")).toBe(false);
  });

  test("keeps `*` and `?` inside one segment", () => {
    expect(matches("docs/*.md", "docs/intro.md")).toBe(true);
    expect(matches("docs/*.md", "docs/guide/intro.md")).toBe(false);
    expect(matches("?.md", "a.md")).toBe(true);
    expect(matches("?.md", "ab.md")).toBe(false);
  });

  test("supports brace alternation and bracket classes", () => {
    expect(matches("*.{md,txt}", "notes.txt")).toBe(true);
    expect(matches("*.{md,txt}", "notes.ts")).toBe(false);
    expect(matches("[abc].ts", "b.ts")).toBe(true);
    expect(matches("[!abc].ts", "d.ts")).toBe(true);
    expect(matches("[!abc].ts", "a.ts")).toBe(false);
  });

  test("matches the common agent-review shapes", () => {
    expect(matches("**/*.test.ts", "src/core/run/config.test.ts")).toBe(true);
    expect(matches("**/*.test.ts", "src/core/run/config.ts")).toBe(false);
    expect(matches("node_modules", "vendor/node_modules/left-pad/index.js")).toBe(true);
  });

  test("normalizes Windows separators and `./` prefixes on both sides", () => {
    expect(matches(".\\docs\\**", "docs/intro.md")).toBe(true);
    expect(isExcludedPath("docs\\intro.md", compileExcludeMatchers(["docs/**"])!)).toBe(true);
    expect(matches("./docs/**", "./docs/intro.md")).toBe(true);
  });

  test("treats regex metacharacters in a pattern as literal text", () => {
    expect(matches("a+b.ts", "a+b.ts")).toBe(true);
    expect(matches("a+b.ts", "aab.ts")).toBe(false);
    expect(matches("release(1).md", "release(1).md")).toBe(true);
  });
});

describe("compileExcludeMatchers", () => {
  test("returns undefined when nothing is excluded", () => {
    expect(compileExcludeMatchers(undefined)).toBeUndefined();
    expect(compileExcludeMatchers([])).toBeUndefined();
  });

  test("rejects a pattern that cannot name a path", () => {
    expect(() => compileExcludeMatchers([" "])).toThrow(/Expected a glob pattern to exclude/);
    expect(() => compileExcludeMatchers(["/"])).toThrow(/Expected a glob pattern to exclude/);
  });

  test("closes an unbalanced brace instead of compiling an invalid expression", () => {
    expect(() => compileExcludeMatchers(["*.{md"])).not.toThrow();
    expect(matches("*.{md", "notes.md")).toBe(true);
  });
});

describe("filterExcludedDiffFiles", () => {
  const files = [
    createTestDiffFile({ id: "readme", path: "README.md" }),
    createTestDiffFile({ id: "app", path: "src/app.ts" }),
    createTestDiffFile({ id: "spec", path: "src/app.test.ts" }),
  ];

  test("returns the same list when no patterns are configured", () => {
    expect(filterExcludedDiffFiles(files, undefined)).toBe(files);
    expect(filterExcludedDiffFiles(files, [])).toBe(files);
  });

  test("drops every file matched by any pattern", () => {
    const kept = filterExcludedDiffFiles(files, ["*.md", "**/*.test.ts"]);
    expect(kept.map((file) => file.path)).toEqual(["src/app.ts"]);
  });

  test("keeps a rename unless both of its paths are excluded", () => {
    const renamedOut = createTestDiffFile({
      id: "renamed-out",
      path: "notes.ts",
      previousPath: "notes.md",
    });
    const renamedWithin = createTestDiffFile({
      id: "renamed-within",
      path: "guide.md",
      previousPath: "notes.md",
    });

    const kept = filterExcludedDiffFiles([renamedOut, renamedWithin], ["*.md"]);
    expect(kept.map((file) => file.path)).toEqual(["notes.ts"]);
  });
});
