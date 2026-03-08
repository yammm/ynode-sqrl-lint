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
