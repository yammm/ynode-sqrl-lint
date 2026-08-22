import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createFormattingDiagnostic, createSarifReport, FORMATTING_RULE_ID } from "../cli.js";

const cliPath = path.resolve(process.cwd(), "cli.js");

function runCli(args, { cwd, input } = {}) {
    return spawnSync(process.execPath, [cliPath, ...args], {
        cwd,
        encoding: "utf8",
        input,
    });
}

function withTempDir(callback) {
    const directory = mkdtempSync(path.join(tmpdir(), "sqrl-lint-sarif-"));
    try {
        callback(directory);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

test("formatting diagnostics identify the first changed original-source position", () => {
    assert.deepStrictEqual(createFormattingDiagnostic("first\n{{x}}", "first\n{{ x }}"), {
        ruleId: FORMATTING_RULE_ID,
        severity: "error",
        message:
            "Template formatting does not match @ynode/sqrl-lint. Run with --fix to apply safe formatting.",
        index: 8,
        line: 2,
        column: 3,
        fixable: true,
    });
    assert.strictEqual(createFormattingDiagnostic("{{ x }}", "{{ x }}"), null);
});

test("SARIF reports stable rules, precise regions, source-root URIs, and tool failures", () => {
    const cwd = path.resolve("/workspace/project");
    const report = createSarifReport({
        cwd,
        exitCode: 2,
        results: [
            {
                file: path.join(cwd, "views", "page.sqrl"),
                status: "needs-formatting",
                formattingDiagnostic: {
                    ruleId: FORMATTING_RULE_ID,
                    severity: "error",
                    message: "Formatting differs.",
                    index: 8,
                    line: 2,
                    column: 3,
                    fixable: true,
                },
                diagnostics: [
                    {
                        ruleId: "no-output-assignment",
                        severity: "error",
                        message: "Assignment renders a value.",
                        index: 20,
                        line: 3,
                        column: 4,
                        fixable: false,
                    },
                ],
            },
            {
                file: path.join(cwd, "views", "unreadable.sqrl"),
                status: "error",
                error: "Permission denied.",
            },
        ],
        stats: { filesMatched: 2, processingErrors: 1 },
    });
    const [run] = report.runs;

    assert.strictEqual(report.$schema, "https://json.schemastore.org/sarif-2.1.0.json");
    assert.strictEqual(report.version, "2.1.0");
    assert.deepStrictEqual(
        run.tool.driver.rules.map(({ id }) => id),
        [FORMATTING_RULE_ID, "no-output-assignment"],
    );
    assert.deepStrictEqual(
        run.results.map(({ ruleId, ruleIndex }) => [ruleId, ruleIndex]),
        [
            [FORMATTING_RULE_ID, 0],
            ["no-output-assignment", 1],
        ],
    );
    assert.deepStrictEqual(run.results[0].locations[0].physicalLocation, {
        artifactLocation: { uri: "views/page.sqrl", uriBaseId: "%SRCROOT%" },
        region: { startLine: 2, startColumn: 3, charOffset: 8 },
    });
    assert.strictEqual(run.columnKind, "utf16CodeUnits");
    assert.strictEqual(run.invocations[0].executionSuccessful, false);
    assert.strictEqual(
        run.invocations[0].toolExecutionNotifications[0].locations[0].physicalLocation
            .artifactLocation.uri,
        "views/unreadable.sqrl",
    );
});

test("--report sarif emits semantic and formatting findings to stdout", () => {
    withTempDir((directory) => {
        const file = path.join(directory, "page.sqrl");
        writeFileSync(file, "heading\n{{it.value = 1}}", "utf8");

        const result = runCli([file, "--report", "sarif"], { cwd: directory });
        const report = JSON.parse(result.stdout);
        const findings = report.runs[0].results;

        assert.strictEqual(result.status, 1);
        assert.strictEqual(result.stderr, "");
        assert.deepStrictEqual(
            findings.map(({ ruleId }) => ruleId),
            [FORMATTING_RULE_ID, "no-output-assignment"],
        );
        assert.deepStrictEqual(
            findings.map(({ locations }) => locations[0].physicalLocation.artifactLocation.uri),
            ["page.sqrl", "page.sqrl"],
        );
        assert.deepStrictEqual(findings[0].locations[0].physicalLocation.region, {
            startLine: 2,
            startColumn: 3,
            charOffset: 10,
        });
    });
});

test("successful SARIF fix mode does not report resolved formatting", () => {
    withTempDir((directory) => {
        const file = path.join(directory, "page.sqrl");
        writeFileSync(file, "{{it.value}}", "utf8");

        const result = runCli([file, "--fix", "--report", "sarif"], { cwd: directory });
        const report = JSON.parse(result.stdout);

        assert.strictEqual(result.status, 0);
        assert.deepStrictEqual(report.runs[0].results, []);
        assert.strictEqual(report.runs[0].invocations[0].executionSuccessful, true);
        assert.strictEqual(report.runs[0].properties.fixedFiles, 1);
        assert.strictEqual(report.runs[0].properties.lintErrors, 0);
    });
});

test("stdin keeps template data on stdout and writes SARIF to stderr", () => {
    const input = "{{foo}}";
    const result = runCli(
        ["--stdin", "--stdin-filepath", "views/virtual.sqrl", "--report", "sarif"],
        { input },
    );
    const report = JSON.parse(result.stderr);

    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.stdout, "{{ foo }}");
    assert.strictEqual(report.runs[0].results[0].ruleId, FORMATTING_RULE_ID);
    assert.strictEqual(
        report.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
        "views/virtual.sqrl",
    );
});

test("SARIF represents operational failures as invocation notifications", () => {
    const result = runCli(["missing/**/*.sqrl", "--report", "sarif"]);
    const report = JSON.parse(result.stdout);
    const invocation = report.runs[0].invocations[0];

    assert.strictEqual(result.status, 2);
    assert.strictEqual(report.runs[0].results.length, 0);
    assert.strictEqual(invocation.exitCode, 2);
    assert.strictEqual(invocation.executionSuccessful, false);
    assert.match(invocation.toolExecutionNotifications[0].message.text, /No files matched/u);
});
