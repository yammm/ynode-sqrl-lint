import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliPath = path.resolve(process.cwd(), "cli.js");

function runCli(args) {
    return spawnSync(process.execPath, [cliPath, ...args], {
        encoding: "utf8",
    });
}

function makeTempDir() {
    return mkdtempSync(path.join(tmpdir(), "sqrl-lint-cli-test-"));
}

test("check mode exits 1 when formatting is required", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "sample.sqrl");
    try {
        writeFileSync(file, "{{foo}}", "utf8");
        const result = runCli([file]);
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

test(
    "fix mode exits 1 when a file cannot be processed",
    { skip: process.platform === "win32" },
    () => {
        const dir = makeTempDir();
        const file = path.join(dir, "locked.sqrl");
        try {
            writeFileSync(file, "{{foo}}", "utf8");
            chmodSync(file, 0o000);
            const result = runCli([file, "--fix"]);
            assert.strictEqual(result.status, 1);
            assert.match(result.stderr, /Encountered errors while processing 1 files/);
        } finally {
            chmodSync(file, 0o600);
            rmSync(dir, { recursive: true, force: true });
        }
    },
);

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
        assert.deepStrictEqual(payload.results, [
            {
                file,
                status: "needs-formatting",
            },
        ]);
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

test("invalid --concurrency values fail fast", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "sample.sqrl");
    try {
        writeFileSync(file, "{{foo}}", "utf8");
        const result = runCli([file, "--concurrency", "0"]);
        assert.strictEqual(result.status, 1);
        assert.match(result.stderr, /Invalid `--concurrency` value/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
