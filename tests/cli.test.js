import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

/** Absolute path to the CLI entry point under test. */
const cliPath = path.resolve(process.cwd(), "cli.js");

/**
 * Spawns the CLI in a child process and returns the result synchronously.
 *
 * @param {string[]} args - CLI arguments (flags + positional globs).
 * @param {Object} [options] - Optional spawn overrides.
 * @param {string} [options.input] - Data piped to the child's stdin (for `--stdin` tests).
 * @returns {import("node:child_process").SpawnSyncReturns<string>} The captured stdout, stderr, and exit status.
 */
function runCli(args, { input } = {}) {
    return spawnSync(process.execPath, [cliPath, ...args], {
        encoding: "utf8",
        input,
    });
}

/**
 * Creates a disposable temp directory for test fixtures.
 * Callers are responsible for cleaning up with `rmSync(dir, { recursive: true })`.
 *
 * @returns {string} Absolute path to the new temp directory.
 */
function makeTempDir() {
    return mkdtempSync(path.join(tmpdir(), "sqrl-lint-cli-test-"));
}

test("check mode exits 1 when formatting is required", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "sample.sqrl");
    try {
        writeFileSync(file, "{{foo}}", "utf8");
        const result = runCli([file, "--no-color"]);
        assert.strictEqual(result.status, 1);
        assert.match(result.stderr, /not formatted correctly/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("fix mode rewrites files and exits 0", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "sample.sqrl");
    try {
        writeFileSync(file, "{{foo}}", "utf8");
        const result = runCli([file, "--fix"]);
        assert.strictEqual(result.status, 0);
        assert.match(result.stdout, /Formatted:/);
        assert.strictEqual(readFileSync(file, "utf8"), "{{ foo }}");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("fix mode exits 2 when a file cannot be processed", { skip: process.platform === "win32" }, () => {
    const dir = makeTempDir();
    const file = path.join(dir, "locked.sqrl");
    try {
        writeFileSync(file, "{{foo}}", "utf8");
        chmodSync(file, 0o000);
        const result = runCli([file, "--fix"]);
        assert.strictEqual(result.status, 2);
        assert.match(result.stderr, /Encountered errors while processing 1 files/);
    } finally {
        chmodSync(file, 0o600);
        rmSync(dir, { recursive: true, force: true });
    }
});

test("check mode supports --no-color output", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "sample.sqrl");
    try {
        writeFileSync(file, "{{foo}}", "utf8");
        const result = runCli([file, "--no-color"]);
        assert.strictEqual(result.status, 1);
        assert.strictEqual(result.stderr.includes(String.fromCharCode(27)), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("check mode supports --report json output", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "sample.sqrl");
    try {
        writeFileSync(file, "{{foo}}", "utf8");
        const result = runCli([file, "--report", "json"]);
        assert.strictEqual(result.status, 1);
        assert.strictEqual(result.stderr, "");

        const payload = JSON.parse(result.stdout);
        assert.strictEqual(payload.mode, "check");
        assert.strictEqual(payload.success, false);
        assert.strictEqual(payload.concurrency, 1);
        assert.strictEqual(payload.filesMatched, 1);
        assert.strictEqual(payload.fixedFiles, 0);
        assert.strictEqual(payload.lintErrors, 1);
        assert.strictEqual(payload.processingErrors, 0);
        assert.ok(Array.isArray(payload.results));
        assert.strictEqual(payload.results.length, 1);
        assert.strictEqual(payload.results[0].file, file);
        assert.strictEqual(payload.results[0].status, "needs-formatting");
        // --diff is on by default, so diff field should be present
        assert.ok(typeof payload.results[0].diff === "string", "diff field should be present by default");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("fix mode supports --concurrency for parallel file processing", () => {
    const dir = makeTempDir();
    const a = path.join(dir, "a.sqrl");
    const b = path.join(dir, "b.sqrl");
    const c = path.join(dir, "c.sqrl");
    try {
        writeFileSync(a, "{{foo}}", "utf8");
        writeFileSync(b, "{{bar}}", "utf8");
        writeFileSync(c, "{{baz}}", "utf8");

        const result = runCli([path.join(dir, "*.sqrl"), "--fix", "--concurrency", "3"]);
        assert.strictEqual(result.status, 0);
        assert.strictEqual(readFileSync(a, "utf8"), "{{ foo }}");
        assert.strictEqual(readFileSync(b, "utf8"), "{{ bar }}");
        assert.strictEqual(readFileSync(c, "utf8"), "{{ baz }}");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("invalid --concurrency values exit 2", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "sample.sqrl");
    try {
        writeFileSync(file, "{{foo}}", "utf8");
        const result = runCli([file, "--concurrency", "0"]);
        assert.strictEqual(result.status, 2);
        assert.match(result.stderr, /Invalid `--concurrency` value/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("--concurrency above cap exits 2", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "sample.sqrl");
    try {
        writeFileSync(file, "{{foo}}", "utf8");
        const result = runCli([file, "--concurrency", "99999"]);
        assert.strictEqual(result.status, 2);
        assert.match(result.stderr, /Maximum is/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("check mode --diff shows unified diff output", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "sample.sqrl");
    try {
        writeFileSync(file, "{{foo}}", "utf8");
        const result = runCli([file, "--diff", "--no-color"]);
        assert.strictEqual(result.status, 1);
        assert.match(result.stderr, /---/);
        assert.match(result.stderr, /\+\+\+/);
        assert.match(result.stderr, /-\{\{foo\}\}/);
        assert.match(result.stderr, /\+\{\{ foo \}\}/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("--no-diff suppresses diff output", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "sample.sqrl");
    try {
        writeFileSync(file, "{{foo}}", "utf8");
        const result = runCli([file, "--no-diff", "--no-color"]);
        assert.strictEqual(result.status, 1);
        assert.match(result.stderr, /not formatted correctly/);
        assert.ok(!result.stderr.includes("---"), "should not contain diff header");
        assert.ok(!result.stderr.includes("+++"), "should not contain diff header");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("--no-diff excludes diff field from JSON report", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "sample.sqrl");
    try {
        writeFileSync(file, "{{foo}}", "utf8");
        const result = runCli([file, "--report", "json", "--no-diff"]);
        assert.strictEqual(result.status, 1);
        const payload = JSON.parse(result.stdout);
        assert.strictEqual(payload.results[0].diff, undefined, "diff field should not be present with --no-diff");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("check mode --diff shows nothing for clean files", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "clean.sqrl");
    try {
        writeFileSync(file, "{{ foo }}", "utf8");
        const result = runCli([file, "--diff", "--no-color"]);
        assert.strictEqual(result.status, 0);
        assert.ok(!result.stderr.includes("---"));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("--report json --diff includes diff field in results", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "sample.sqrl");
    try {
        writeFileSync(file, "{{foo}}", "utf8");
        const result = runCli([file, "--report", "json", "--diff"]);
        assert.strictEqual(result.status, 1);

        const payload = JSON.parse(result.stdout);
        assert.strictEqual(payload.results.length, 1);
        assert.ok(typeof payload.results[0].diff === "string", "diff field should be a string");
        assert.ok(payload.results[0].diff.includes("-{{foo}}"), "diff should show removed line");
        assert.ok(payload.results[0].diff.includes("+{{ foo }}"), "diff should show added line");
        // JSON diff should not contain ANSI escape codes
        assert.strictEqual(payload.results[0].diff.includes("\x1b["), false, "diff should not contain ANSI codes");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("--quiet suppresses all output in check mode", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "sample.sqrl");
    try {
        writeFileSync(file, "{{foo}}", "utf8");
        const result = runCli([file, "--quiet"]);
        assert.strictEqual(result.status, 1);
        assert.strictEqual(result.stdout, "");
        assert.strictEqual(result.stderr, "");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("--quiet suppresses all output in fix mode", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "sample.sqrl");
    try {
        writeFileSync(file, "{{foo}}", "utf8");
        const result = runCli([file, "--fix", "--quiet"]);
        assert.strictEqual(result.status, 0);
        assert.strictEqual(result.stdout, "");
        assert.strictEqual(result.stderr, "");
        assert.strictEqual(readFileSync(file, "utf8"), "{{ foo }}");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("processing error exits 2 not 1", { skip: process.platform === "win32" }, () => {
    const dir = makeTempDir();
    const file = path.join(dir, "locked.sqrl");
    try {
        writeFileSync(file, "{{foo}}", "utf8");
        chmodSync(file, 0o000);
        const result = runCli([file, "--report", "json"]);
        assert.strictEqual(result.status, 2);
        const payload = JSON.parse(result.stdout);
        assert.strictEqual(payload.processingErrors, 1);
    } finally {
        chmodSync(file, 0o600);
        rmSync(dir, { recursive: true, force: true });
    }
});

// --stdin tests

test("--stdin check mode writes formatted output to stdout and exits 1 for dirty input", () => {
    const result = runCli(["--stdin", "--no-diff", "--no-color"], { input: "{{foo}}" });
    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.stdout, "{{ foo }}");
    assert.match(result.stderr, /not formatted correctly/);
});

test("--stdin check mode exits 0 for clean input", () => {
    const result = runCli(["--stdin"], { input: "{{ foo }}" });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "{{ foo }}");
    assert.strictEqual(result.stderr, "");
});

test("--stdin --fix writes formatted output to stdout and exits 0", () => {
    const result = runCli(["--stdin", "--fix"], { input: "{{foo}}" });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "{{ foo }}");
});

test("--stdin --diff shows unified diff on stderr", () => {
    const result = runCli(["--stdin", "--diff", "--no-color"], { input: "{{foo}}" });
    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.stdout, "{{ foo }}");
    assert.match(result.stderr, /---/);
    assert.match(result.stderr, /\+\+\+/);
});

test("--stdin --stdin-filepath uses custom path in diff header", () => {
    const result = runCli(["--stdin", "--stdin-filepath", "views/home.sqrl", "--diff", "--no-color"], {
        input: "{{foo}}",
    });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /views\/home\.sqrl/);
});

test("--stdin --quiet suppresses all stderr output", () => {
    const result = runCli(["--stdin", "--quiet"], { input: "{{foo}}" });
    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.stdout, "{{ foo }}");
    assert.strictEqual(result.stderr, "");
});
