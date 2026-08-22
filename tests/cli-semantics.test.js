import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliPath = path.resolve(process.cwd(), "cli.js");

function runCli(args, { input, cwd } = {}) {
    return spawnSync(process.execPath, [cliPath, ...args], {
        cwd,
        encoding: "utf8",
        input,
    });
}

function withTempDir(callback) {
    const directory = mkdtempSync(path.join(tmpdir(), "sqrl-lint-cli-semantics-"));
    try {
        callback(directory);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

test("check mode fails and prints source locations for semantic diagnostics", () => {
    withTempDir((directory) => {
        const file = path.join(directory, "assignment.sqrl");
        writeFileSync(file, "{{ it.value = 1 }}", "utf8");

        const result = runCli([file, "--no-color", "--no-diff"]);

        assert.strictEqual(result.status, 1);
        assert.strictEqual(result.stdout, "");
        assert.match(
            result.stderr,
            new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:1:4`, "u"),
        );
        assert.match(result.stderr, /\[no-output-assignment\]/u);
    });
});

test("JSON reports include structured diagnostics", () => {
    withTempDir((directory) => {
        const file = path.join(directory, "assignment.sqrl");
        writeFileSync(file, "{{ it.value = 1 }}", "utf8");

        const result = runCli([file, "--report", "json", "--no-diff"]);
        const payload = JSON.parse(result.stdout);

        assert.strictEqual(result.status, 1);
        assert.strictEqual(payload.success, false);
        assert.strictEqual(payload.lintErrors, 1);
        assert.strictEqual(payload.results[0].status, "lint-error");
        assert.deepStrictEqual(payload.results[0].diagnostics[0], {
            ruleId: "no-output-assignment",
            severity: "error",
            message:
                "Assignments and updates in output tags render their resulting value. Use an execution tag (`{{! ... }}`) for side effects.",
            index: 3,
            line: 1,
            column: 4,
            fixable: false,
        });
    });
});

test("fix mode writes safe formatting but still fails for unresolved diagnostics", () => {
    withTempDir((directory) => {
        const file = path.join(directory, "assignment.sqrl");
        writeFileSync(file, "{{it.value = 1}}", "utf8");

        const result = runCli([file, "--fix", "--no-color"]);

        assert.strictEqual(result.status, 1);
        assert.strictEqual(readFileSync(file, "utf8"), "{{ it.value = 1 }}");
        assert.match(result.stdout, /Formatted:/u);
        assert.match(result.stderr, /\[no-output-assignment\]/u);
        assert.match(result.stderr, /still have semantic errors/u);
    });
});

test("fix mode repairs top-level logical OR and exits cleanly", () => {
    withTempDir((directory) => {
        const file = path.join(directory, "fallback.sqrl");
        writeFileSync(file, '{{ it.value || "fallback" }}', "utf8");

        const check = runCli([file, "--no-color", "--no-diff"]);
        assert.strictEqual(check.status, 1);
        assert.match(check.stderr, /\[no-unparenthesized-logical-or\]/u);

        const fixed = runCli([file, "--fix", "--quiet"]);
        assert.strictEqual(fixed.status, 0);
        assert.strictEqual(readFileSync(file, "utf8"), '{{ (it.value || "fallback") }}');
    });
});

test("project configuration selects nullish fixes for files and stdin", () => {
    withTempDir((directory) => {
        const file = path.join(directory, "fallback.sqrl");
        writeFileSync(
            path.join(directory, ".sqrl-lintrc.json"),
            JSON.stringify({ logicalOrFix: "nullish" }),
            "utf8",
        );
        writeFileSync(file, '{{ it.value || "fallback" }}', "utf8");

        const fileResult = runCli([file, "--fix", "--quiet"], { cwd: directory });
        const stdinResult = runCli(["--stdin", "--fix", "--quiet"], {
            cwd: directory,
            input: '{{ it.other || "fallback" }}',
        });

        assert.strictEqual(fileResult.status, 0);
        assert.strictEqual(readFileSync(file, "utf8"), '{{ it.value ?? "fallback" }}');
        assert.strictEqual(stdinResult.status, 0);
        assert.strictEqual(stdinResult.stdout, '{{ it.other ?? "fallback" }}');
        assert.strictEqual(stdinResult.stderr, "");
    });
});

test("the CLI loads an implicit .sqrl-lintrc.json from its working directory", () => {
    withTempDir((directory) => {
        const file = path.join(directory, "execution.sqrl");
        writeFileSync(
            path.join(directory, ".sqrl-lintrc.json"),
            JSON.stringify({ forbidExecute: true }),
            "utf8",
        );
        writeFileSync(file, "{{! it.ready = true; }}", "utf8");

        const result = runCli([file, "--no-color"], { cwd: directory });

        assert.strictEqual(result.status, 1);
        assert.match(result.stderr, /\[no-execute-tag\]/u);
    });
});

test("--config loads a strict explicit configuration", () => {
    withTempDir((directory) => {
        const file = path.join(directory, "filter.sqrl");
        writeFileSync(
            path.join(directory, "policy.json"),
            JSON.stringify({ knownFilters: ["date"] }),
            "utf8",
        );
        writeFileSync(file, "{{ it.value | data }}", "utf8");

        const result = runCli([file, "--config", "policy.json", "--no-color"], { cwd: directory });

        assert.strictEqual(result.status, 1);
        assert.match(result.stderr, /Unknown Squirrelly filter `data`/u);
        assert.match(result.stderr, /Did you mean `date`/u);
    });
});

test("invalid and missing explicit configurations are operational errors", () => {
    withTempDir((directory) => {
        const file = path.join(directory, "clean.sqrl");
        writeFileSync(file, "{{ it.value }}", "utf8");
        writeFileSync(
            path.join(directory, "invalid.json"),
            JSON.stringify({ forbidExec: true }),
            "utf8",
        );

        const invalid = runCli([file, "--config", "invalid.json", "--no-color"], {
            cwd: directory,
        });
        assert.strictEqual(invalid.status, 2);
        assert.match(invalid.stderr, /unknown option "forbidExec"/u);

        const missing = runCli([file, "--config", "missing.json", "--no-color"], {
            cwd: directory,
        });
        assert.strictEqual(missing.status, 2);
        assert.match(missing.stderr, /missing\.json/u);
    });
});

test("configured optional-chain protection is applied in fix mode", () => {
    withTempDir((directory) => {
        const file = path.join(directory, "optional.sqrl");
        writeFileSync(
            path.join(directory, ".sqrl-lintrc.json"),
            JSON.stringify({ noImplicitNullOutput: true }),
            "utf8",
        );
        writeFileSync(file, "{{ it.user?.name }}", "utf8");

        const result = runCli([file, "--fix", "--quiet"], { cwd: directory });

        assert.strictEqual(result.status, 0);
        assert.strictEqual(readFileSync(file, "utf8"), '{{ it.user?.name ?? "" }}');
    });
});

test("stdin text mode preserves stdout and reports semantic diagnostics on stderr", () => {
    const input = "{{ it.value = 1 }}";
    const result = runCli(["--stdin", "--no-color"], { input });

    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.stdout, input);
    assert.match(result.stderr, /<stdin>:1:4/u);
    assert.match(result.stderr, /\[no-output-assignment\]/u);
});

test("stdin fix mode returns safely repaired content with exit code zero", () => {
    const result = runCli(["--stdin", "--fix"], { input: '{{ it.value || "fallback" }}' });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, '{{ (it.value || "fallback") }}');
    assert.strictEqual(result.stderr, "");
});

test("stdin JSON mode keeps structured diagnostics on stderr", () => {
    const input = "{{ it.value = 1 }}";
    const result = runCli(["--stdin", "--report", "json"], { input });
    const payload = JSON.parse(result.stderr);

    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.stdout, input);
    assert.strictEqual(payload.results[0].status, "lint-error");
    assert.strictEqual(payload.results[0].diagnostics[0].ruleId, "no-output-assignment");
});

test("stdin and file JSON use the same status precedence for formatting plus diagnostics", () => {
    const result = runCli(["--stdin", "--report", "json"], { input: "{{it.value = 1}}" });
    const payload = JSON.parse(result.stderr);

    assert.strictEqual(result.status, 1);
    assert.strictEqual(payload.results[0].status, "needs-formatting");
    assert.strictEqual(payload.results[0].diagnostics[0].ruleId, "no-output-assignment");
});

test("file JSON results account for both clean and failing matched files", () => {
    withTempDir((directory) => {
        const clean = path.join(directory, "a-clean.sqrl");
        const failing = path.join(directory, "b-failing.sqrl");
        writeFileSync(clean, "{{ it.value }}", "utf8");
        writeFileSync(failing, "{{ it.value = 1 }}", "utf8");

        const result = runCli([path.join(directory, "*.sqrl"), "--report", "json", "--no-diff"]);
        const payload = JSON.parse(result.stdout);

        assert.strictEqual(result.status, 1);
        assert.strictEqual(payload.filesMatched, 2);
        assert.strictEqual(payload.results.length, 2);
        assert.deepStrictEqual(
            payload.results.map(({ file, status }) => [file, status]),
            [
                [clean, "unchanged"],
                [failing, "lint-error"],
            ],
        );
    });
});
