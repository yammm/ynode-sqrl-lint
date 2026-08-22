#!/usr/bin/env node

/**
 * The MIT License (MIT)
 * Copyright (c) 2026 Michael Welter <me@mikinho.com>
 */

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import fg from "fast-glob";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { createLintOptionsResolver, loadLintOptions } from "./src/config.js";
import { lintContent } from "./src/linter.js";

const require = createRequire(import.meta.url);
const packageMetadata = require("./package.json");
const { version } = packageMetadata;

/** Stable rule identifier emitted when only template formatting differs. */
export const FORMATTING_RULE_ID = "formatting";

const FORMATTING_MESSAGE =
    "Template formatting does not match @ynode/sqrl-lint. Run with --fix to apply safe formatting.";

const RULE_DESCRIPTIONS = new Map([
    [FORMATTING_RULE_ID, "Template formatting differs from the canonical output."],
    ["known-filter", "Require filters to appear in the configured project registry."],
    ["no-ambiguous-leading-prefix", "Reject ambiguous Squirrelly tag prefixes."],
    ["no-execute-tag", "Disallow execution tags on restricted template surfaces."],
    ["no-implicit-null-output", "Require an explicit fallback for optional-chain output."],
    ["no-output-assignment", "Disallow assignments and updates in output tags."],
    ["no-safe-filter", "Disallow the safe filter on restricted template surfaces."],
    ["no-unparenthesized-logical-or", "Protect logical OR from Squirrelly filter parsing."],
    ["no-unsafe-raw-json", "Disallow unsafe raw JSON serialization."],
    ["valid-async-syntax", "Require consistent Squirrelly async markers and mode."],
    ["valid-elif", "Require Squirrelly's supported elif spelling."],
    ["valid-filter", "Require well-formed Squirrelly filter segments."],
    ["valid-native-branch", "Require valid native helper branch ordering."],
    ["valid-squirrelly-syntax", "Require a template that the Squirrelly engine can parse."],
]);

/** Available CPU threads (runtime value, computed once). */
const cpuCount = os.availableParallelism?.() ?? os.cpus().length;

/** Maximum parallelism: 2× the available CPU threads. */
const maxParallelism = cpuCount * 2;

/** ANSI escape-code helpers for colorised terminal output. */
const ansiColors = {
    red: (text) => `\x1b[31m${text}\x1b[0m`,
    green: (text) => `\x1b[32m${text}\x1b[0m`,
    cyan: (text) => `\x1b[36m${text}\x1b[0m`,
    gray: (text) => `\x1b[90m${text}\x1b[0m`,
    bold: (text) => `\x1b[1m${text}\x1b[0m`,
};

/**
 * Returns the first changed UTF-16 position between original and formatted
 * source as a normal lint diagnostic. The position is anchored to the original
 * input, matching semantic diagnostics.
 *
 * @param {string} original - Original template source.
 * @param {string} formatted - Canonically formatted source.
 * @returns {{ruleId: string, severity: "error", message: string, index: number, line: number, column: number, fixable: true}|null} Formatting diagnostic, or null when sources match.
 */
export function createFormattingDiagnostic(original, formatted) {
    let index = 0;
    const sharedLength = Math.min(original.length, formatted.length);
    while (index < sharedLength && original[index] === formatted[index]) {
        ++index;
    }
    if (index === original.length && index === formatted.length) {
        return null;
    }

    let line = 1;
    let column = 1;
    for (let cursor = 0; cursor < index; ++cursor) {
        if (original[cursor] === "\n") {
            ++line;
            column = 1;
        } else {
            ++column;
        }
    }
    return {
        ruleId: FORMATTING_RULE_ID,
        severity: "error",
        message: FORMATTING_MESSAGE,
        index,
        line,
        column,
        fixable: true,
    };
}

/**
 * Resolves an existing path through filesystem aliases while retaining a
 * deterministic absolute path for virtual or nonexistent locations.
 *
 * @param {string} filePath - Path to normalize.
 * @returns {string} Canonical absolute path when available.
 */
function resolveCanonicalPath(filePath) {
    const absolutePath = path.resolve(filePath);
    try {
        return realpathSync(absolutePath);
    } catch {
        return absolutePath;
    }
}

/**
 * Converts a local path to a SARIF artifact location. Paths inside the working
 * directory are portable `%SRCROOT%`-relative URIs; outside paths use file URIs.
 *
 * @param {string} filePath - Real or virtual lint target path.
 * @param {string} cwd - SARIF source root.
 * @returns {{uri: string, uriBaseId?: string}} SARIF artifact location.
 */
function createArtifactLocation(filePath, cwd) {
    const sourceRoot = resolveCanonicalPath(cwd);
    const absolutePath = resolveCanonicalPath(path.resolve(sourceRoot, filePath));
    const relativePath = path.relative(sourceRoot, absolutePath);
    if (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`)) {
        return {
            uri: relativePath.split(path.sep).map(encodeURIComponent).join("/"),
            uriBaseId: "%SRCROOT%",
        };
    }
    return { uri: pathToFileURL(absolutePath).href };
}

/**
 * Builds a deterministic SARIF 2.1.0 log from CLI file results.
 *
 * @param {object} options - SARIF report options.
 * @param {Array<{file?: string, diagnostics?: object[], formattingDiagnostic?: object, status?: string, error?: string}>} [options.results=[]] - Internal CLI results.
 * @param {"check"|"fix"} [options.mode="check"] - Lint invocation mode.
 * @param {number} [options.exitCode=0] - Process exit code represented by the invocation.
 * @param {string} [options.cwd=process.cwd()] - Source root for artifact URIs.
 * @param {{filesMatched?: number, fixedFiles?: number, lintErrors?: number, processingErrors?: number, durationMs?: number}} [options.stats={}] - Run summary properties.
 * @returns {object} SARIF 2.1.0 log.
 */
export function createSarifReport({
    results = [],
    mode = "check",
    exitCode = 0,
    cwd = process.cwd(),
    stats = {},
} = {}) {
    const findings = [];
    const notifications = [];

    for (const entry of results) {
        if (entry.error) {
            notifications.push({
                level: "error",
                message: { text: entry.error },
                ...(entry.file
                    ? {
                          locations: [
                              {
                                  physicalLocation: {
                                      artifactLocation: createArtifactLocation(entry.file, cwd),
                                  },
                              },
                          ],
                      }
                    : {}),
            });
        }
        if (!entry.file) {
            continue;
        }
        const entryFindings = [
            ...(entry.formattingDiagnostic ? [entry.formattingDiagnostic] : []),
            ...(entry.diagnostics ?? []),
        ].sort(
            (left, right) =>
                left.line - right.line ||
                left.column - right.column ||
                left.ruleId.localeCompare(right.ruleId),
        );
        for (const diagnostic of entryFindings) {
            findings.push({ file: entry.file, diagnostic });
        }
    }

    const ruleIds = [...new Set(findings.map(({ diagnostic }) => diagnostic.ruleId))].sort();
    const ruleIndex = new Map(ruleIds.map((ruleId, index) => [ruleId, index]));
    const documentationUrl = new URL(packageMetadata.homepage);
    documentationUrl.hash = "";
    const rules = ruleIds.map((ruleId) => ({
        id: ruleId,
        shortDescription: {
            text: RULE_DESCRIPTIONS.get(ruleId) ?? `Squirrelly lint rule ${ruleId}.`,
        },
        helpUri: `${documentationUrl.href}${ruleId === FORMATTING_RULE_ID ? "#formatting-rules" : "#semantic-rules"}`,
        defaultConfiguration: { level: "error" },
    }));
    const sarifResults = findings.map(({ file, diagnostic }) => ({
        ruleId: diagnostic.ruleId,
        ruleIndex: ruleIndex.get(diagnostic.ruleId),
        level: "error",
        message: { text: diagnostic.message },
        locations: [
            {
                physicalLocation: {
                    artifactLocation: createArtifactLocation(file, cwd),
                    region: {
                        startLine: diagnostic.line,
                        startColumn: diagnostic.column,
                        charOffset: diagnostic.index,
                    },
                },
            },
        ],
        properties: { fixable: diagnostic.fixable === true },
    }));

    return {
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        version: "2.1.0",
        runs: [
            {
                tool: {
                    driver: {
                        name: packageMetadata.name,
                        semanticVersion: version,
                        informationUri: packageMetadata.homepage,
                        rules,
                    },
                },
                columnKind: "utf16CodeUnits",
                originalUriBaseIds: {
                    "%SRCROOT%": {
                        uri: pathToFileURL(`${resolveCanonicalPath(cwd)}${path.sep}`).href,
                    },
                },
                invocations: [
                    {
                        executionSuccessful: exitCode !== 2,
                        exitCode,
                        ...(notifications.length > 0
                            ? { toolExecutionNotifications: notifications }
                            : {}),
                    },
                ],
                results: sarifResults,
                properties: { mode, ...stats },
            },
        ],
    };
}

/**
 * Produces a minimal unified-style diff between two strings.
 * Only changed lines are shown, with surrounding context lines.
 *
 * @param {object} options - Diff options.
 * @param {string} options.filePath - Path to display in the diff header.
 * @param {string} options.original - The original content.
 * @param {string} options.formatted - The formatted content.
 * @param {ReturnType<typeof createColors>} [options.colors=noColors] - Color helpers.
 * @param {number} [options.contextLines=3] - Number of unchanged context lines around each change.
 * @returns {string} The formatted diff output.
 */
export function createDiff({ filePath, original, formatted, colors = noColors, contextLines = 3 }) {
    const oldLines = original.split("\n");
    const newLines = formatted.split("\n");
    const operations = createLineDiff(oldLines, newLines);
    const changedIndices = [];
    for (let index = 0; index < operations.length; ++index) {
        if (operations[index].type !== "equal") {
            changedIndices.push(index);
        }
    }

    if (changedIndices.length === 0) {
        return "";
    }

    const output = [colors.bold(`--- a/${filePath}`), colors.bold(`+++ b/${filePath}`)];

    // Group changes whose context windows overlap or touch.
    const hunks = [];
    let hunkStart = Math.max(0, changedIndices[0] - contextLines);
    let hunkEnd = Math.min(operations.length - 1, changedIndices[0] + contextLines);
    for (let index = 1; index < changedIndices.length; ++index) {
        const nextStart = Math.max(0, changedIndices[index] - contextLines);
        const nextEnd = Math.min(operations.length - 1, changedIndices[index] + contextLines);
        if (nextStart <= hunkEnd + 1) {
            hunkEnd = Math.max(hunkEnd, nextEnd);
        } else {
            hunks.push([hunkStart, hunkEnd]);
            hunkStart = nextStart;
            hunkEnd = nextEnd;
        }
    }
    hunks.push([hunkStart, hunkEnd]);

    let operationIndex = 0;
    let oldLineNumber = 1;
    let newLineNumber = 1;

    for (const [start, end] of hunks) {
        while (operationIndex < start) {
            const operation = operations[operationIndex];
            if (operation.type !== "insert") {
                ++oldLineNumber;
            }
            if (operation.type !== "delete") {
                ++newLineNumber;
            }
            ++operationIndex;
        }

        let oldCount = 0;
        let newCount = 0;
        const hunkLines = [];
        for (; operationIndex <= end; ++operationIndex) {
            const operation = operations[operationIndex];
            if (operation.type === "equal") {
                hunkLines.push(` ${operation.line}`);
                ++oldCount;
                ++newCount;
                continue;
            }
            if (operation.type === "delete") {
                hunkLines.push(colors.red(`-${operation.line}`));
                ++oldCount;
                continue;
            }
            hunkLines.push(colors.green(`+${operation.line}`));
            ++newCount;
        }

        const oldStart = oldCount === 0 ? Math.max(0, oldLineNumber - 1) : oldLineNumber;
        const newStart = newCount === 0 ? Math.max(0, newLineNumber - 1) : newLineNumber;
        output.push(colors.cyan(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`));
        output.push(...hunkLines);

        oldLineNumber += oldCount;
        newLineNumber += newCount;
    }

    return output.join("\n");
}

/**
 * Computes a shortest line edit script with Myers' diff algorithm.
 *
 * @param {string[]} oldLines - Original lines.
 * @param {string[]} newLines - Formatted lines.
 * @returns {Array<{type: "equal" | "delete" | "insert", line: string}>} Ordered edit operations.
 */
function createLineDiff(oldLines, newLines) {
    const operations = [];
    let prefixLength = 0;
    while (
        prefixLength < oldLines.length &&
        prefixLength < newLines.length &&
        oldLines[prefixLength] === newLines[prefixLength]
    ) {
        operations.push({ type: "equal", line: oldLines[prefixLength] });
        ++prefixLength;
    }

    let oldSuffixIndex = oldLines.length - 1;
    let newSuffixIndex = newLines.length - 1;
    const suffix = [];
    while (
        oldSuffixIndex >= prefixLength &&
        newSuffixIndex >= prefixLength &&
        oldLines[oldSuffixIndex] === newLines[newSuffixIndex]
    ) {
        suffix.push({ type: "equal", line: oldLines[oldSuffixIndex] });
        --oldSuffixIndex;
        --newSuffixIndex;
    }

    const oldMiddle = oldLines.slice(prefixLength, oldSuffixIndex + 1);
    const newMiddle = newLines.slice(prefixLength, newSuffixIndex + 1);
    operations.push(...createMiddleLineDiff(oldMiddle, newMiddle));
    operations.push(...suffix.reverse());
    return operations;
}

/**
 * Computes edits for the non-matching middle of two line arrays.
 *
 * Large unrelated inputs fall back to a bounded replacement hunk so
 * diagnostic generation cannot consume quadratic memory.
 *
 * @param {string[]} oldLines - Original middle lines.
 * @param {string[]} newLines - Formatted middle lines.
 * @returns {Array<{type: "equal" | "delete" | "insert", line: string}>} Ordered edit operations.
 */
function createMiddleLineDiff(oldLines, newLines) {
    const maxDistance = oldLines.length + newLines.length;
    if (maxDistance > 512) {
        return [
            ...oldLines.map((line) => ({ type: "delete", line })),
            ...newLines.map((line) => ({ type: "insert", line })),
        ];
    }

    const trace = [];
    const frontier = new Map([[1, 0]]);

    for (let distance = 0; distance <= maxDistance; ++distance) {
        trace.push(new Map(frontier));
        for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
            const previousDelete = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
            const previousInsert = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
            let oldIndex;

            if (
                diagonal === -distance ||
                (diagonal !== distance && previousDelete < previousInsert)
            ) {
                oldIndex = previousInsert;
            } else {
                oldIndex = previousDelete + 1;
            }

            let newIndex = oldIndex - diagonal;
            while (
                oldIndex < oldLines.length &&
                newIndex < newLines.length &&
                oldLines[oldIndex] === newLines[newIndex]
            ) {
                ++oldIndex;
                ++newIndex;
            }
            frontier.set(diagonal, oldIndex);

            if (oldIndex >= oldLines.length && newIndex >= newLines.length) {
                return backtrackLineDiff(trace, oldLines, newLines);
            }
        }
    }

    return [];
}

/**
 * Reconstructs a line edit script from a Myers frontier trace.
 *
 * @param {Map<number, number>[]} trace - Frontier snapshots.
 * @param {string[]} oldLines - Original lines.
 * @param {string[]} newLines - Formatted lines.
 * @returns {Array<{type: "equal" | "delete" | "insert", line: string}>} Ordered edit operations.
 */
function backtrackLineDiff(trace, oldLines, newLines) {
    const operations = [];
    let oldIndex = oldLines.length;
    let newIndex = newLines.length;

    for (let distance = trace.length - 1; distance >= 0; --distance) {
        const frontier = trace[distance];
        const diagonal = oldIndex - newIndex;
        const previousDelete = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
        const previousInsert = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
        const previousDiagonal =
            diagonal === -distance || (diagonal !== distance && previousDelete < previousInsert)
                ? diagonal + 1
                : diagonal - 1;
        const previousOldIndex = frontier.get(previousDiagonal) ?? 0;
        const previousNewIndex = previousOldIndex - previousDiagonal;

        while (oldIndex > previousOldIndex && newIndex > previousNewIndex) {
            operations.push({ type: "equal", line: oldLines[oldIndex - 1] });
            --oldIndex;
            --newIndex;
        }

        if (distance === 0) {
            break;
        }
        if (oldIndex === previousOldIndex) {
            operations.push({ type: "insert", line: newLines[newIndex - 1] });
            --newIndex;
        } else {
            operations.push({ type: "delete", line: oldLines[oldIndex - 1] });
            --oldIndex;
        }
    }

    return operations.reverse();
}

/** Identity passthrough — no ANSI codes applied. */
const noColors = /** @type {typeof ansiColors} */ (
    Object.fromEntries(Object.keys(ansiColors).map((k) => [k, (text) => text]))
);

/**
 * Returns a color helper object. When disabled, all helpers pass text through
 * unchanged so output is free of ANSI escape codes.
 *
 * @param {boolean} enabled - Whether ANSI colours should be applied.
 * @returns {typeof ansiColors} Color helper functions.
 */
function createColors(enabled) {
    return enabled ? ansiColors : noColors;
}

/**
 * Converts Windows separators in a glob pattern without escaping glob magic.
 * The input is already a pattern, not a literal path, so bracket, brace, and
 * extglob syntax must pass through unchanged.
 *
 * @param {string} pattern - User-provided glob pattern.
 * @param {object} [options] - Platform override used by cross-platform tests.
 * @param {boolean} [options.windows=process.platform === "win32"] - Whether to normalize Windows separators.
 * @returns {string} A fast-glob-compatible pattern.
 */
export function normalizeGlobPattern(pattern, { windows = process.platform === "win32" } = {}) {
    return windows ? pattern.replaceAll("\\", "/") : pattern;
}

/**
 * Replaces a file atomically through a same-directory temporary file while
 * preserving its permission bits. The temporary file is removed on failure.
 *
 * @param {string} file - Destination file path.
 * @param {string} content - Complete replacement content.
 * @returns {Promise<void>}
 */
async function writeFileAtomically(file, content) {
    const destinationFile = await fs.realpath(file);
    const { mode } = await fs.stat(destinationFile);
    const permissionBits = mode & 0o7777;
    const temporaryFile = `${destinationFile}.${process.pid}.${randomUUID()}.tmp`;

    try {
        await fs.writeFile(temporaryFile, content, {
            encoding: "utf8",
            flag: "wx",
            mode: permissionBits,
        });
        await fs.chmod(temporaryFile, permissionBits);
        await fs.rename(temporaryFile, destinationFile);
    } catch (error) {
        try {
            await fs.rm(temporaryFile, { force: true });
        } catch {
            // Preserve the original write/rename error; the random temp name
            // prevents a leftover file from affecting a later invocation.
        }
        throw error;
    }
}

/**
 * Parses CLI arguments without letting yargs assign its own exit code.
 *
 * @returns {{argv: import("yargs").Arguments, argumentError?: Error}} Parsed values and any validation error.
 */
function parseArguments() {
    let argumentError;
    const argv = yargs(hideBin(process.argv))
        .scriptName("sqrl-lint")
        .usage("$0 [globs...]", "Lint Squirrelly templates", (yargs) => {
            yargs.positional("globs", {
                describe: 'Glob patterns of files to lint (e.g., "**/*.sqrl")',
                type: "string",
                array: true,
            });
        })
        .example('$0 "**/*.sqrl"', "Check all .sqrl files for formatting and semantic issues")
        .example('$0 "**/*.sqrl" --fix', "Apply formatting and safe semantic repairs")
        .example(
            "cat file.sqrl | $0 --stdin",
            "Read from stdin and write formatted output to stdout",
        )
        .option("stdin", {
            type: "boolean",
            description:
                "Read from stdin instead of file globs; formatted output is written to stdout",
        })
        .option("stdin-filepath", {
            type: "string",
            description: "Path to display in error messages and diffs when using --stdin",
        })
        .option("fix", {
            alias: "f",
            type: "boolean",
            description: "Apply formatting and safe semantic repairs",
        })
        .option("report", {
            type: "string",
            choices: ["text", "json", "sarif"],
            default: "text",
            description: "Output format",
        })
        .option("color", {
            type: "boolean",
            default: Boolean(process.stdout.isTTY) && !("NO_COLOR" in process.env),
            description: "Enable ANSI color output for text reports (respects NO_COLOR env)",
        })
        .option("diff", {
            alias: "d",
            type: "boolean",
            default: true,
            description: "Show a unified diff for files that need formatting (check mode only)",
        })
        .option("quiet", {
            alias: "q",
            type: "boolean",
            description:
                "Suppress report output; stdin formatted content is still written to stdout",
        })
        .option("ignore", {
            type: "string",
            array: true,
            description: 'Additional glob patterns to ignore (e.g., "**/vendor/**")',
        })
        .option("config", {
            type: "string",
            description: "Path to a sqrl-lint JSON configuration file",
        })
        .option("concurrency", {
            type: "number",
            default: 1,
            description: `Number of files to process in parallel (1–${maxParallelism})`,
        })
        .strict()
        .fail((message, error) => {
            argumentError = error ?? new Error(message);
        })
        .version(version)
        .help()
        .parse();

    return { argv, argumentError };
}

/**
 * Resolves the per-file result status shared by stdin and file modes.
 *
 * @param {object} options - Status inputs.
 * @param {boolean} options.fix - Whether safe fixes were applied.
 * @param {boolean} options.changed - Whether formatting changed the content.
 * @param {number} options.diagnosticCount - Count of remaining semantic diagnostics.
 * @returns {"needs-formatting" | "fixed-with-errors" | "lint-error" | "fixed" | "unchanged"} Result status.
 */
function resolveLintStatus({ fix, changed, diagnosticCount }) {
    if (!fix && changed) {
        return "needs-formatting";
    }
    if (diagnosticCount > 0) {
        return changed ? "fixed-with-errors" : "lint-error";
    }
    return changed ? "fixed" : "unchanged";
}

/**
 * Reads all data from stdin as a UTF-8 string.
 *
 * Collects incoming chunks into an array and joins them once the stream
 * ends, avoiding O(n²) string concatenation on large inputs.
 *
 * @returns {Promise<string>} The complete stdin content.
 */
function readStdin() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => chunks.push(chunk));
        process.stdin.on("end", () => resolve(chunks.join("")));
        process.stdin.on("error", reject);
    });
}

/**
 * Main CLI entry point. Parses arguments, resolves file globs (or reads
 * from stdin), runs the linter across all targets, and emits the
 * appropriate report and exit code.
 *
 * @returns {Promise<void>}
 */
async function run() {
    const { argv, argumentError } = parseArguments();
    const {
        color,
        config: configPath,
        concurrency: concurrencyOption,
        diff,
        fix,
        globs,
        ignore: ignoredPatterns,
        quiet: quietOption,
        report,
        stdin,
        stdinFilepath,
    } = argv;
    const startTime = performance.now();
    const useJsonReport = report === "json";
    const useSarifReport = report === "sarif";
    const useMachineReport = useJsonReport || useSarifReport;
    const quiet = Boolean(quietOption);
    const colors = createColors(color && !useMachineReport && !quiet);
    const concurrency = Number(concurrencyOption);
    const mode = fix ? "fix" : "check";

    /** @type {Array<{file?: string, status: string, error?: string, diff?: string, diagnostics?: object[], formattingDiagnostic?: object}>} */
    const results = [];

    /**
     * Removes SARIF-only internal fields from the existing JSON report schema.
     *
     * @param {object} entry - Internal file result.
     * @returns {object} Public JSON result.
     */
    function publicJsonResult(entry) {
        const copy = { ...entry };
        delete copy.formattingDiagnostic;
        return copy;
    }

    /**
     * Exit codes:
     *   0 – success (all files clean, or all safe fixes applied)
     *   1 – lint failure (formatting or semantic diagnostics remain)
     *   2 – operational error (I/O failures, invalid arguments, etc.)
     */

    /**
     * Emits an operational / configuration error via the active report
     * format (JSON or text) and sets exit code 2.
     *
     * @param {string} message - Human-readable error description.
     */
    function emitConfigurationError(message) {
        if (quiet) {
            process.exitCode = 2;
            return;
        }
        if (useJsonReport || useSarifReport) {
            const durationMs = Math.round(performance.now() - startTime);
            const errorResult = { status: "error", error: message };
            const reportPayload = useSarifReport
                ? createSarifReport({
                      results: [errorResult],
                      mode,
                      exitCode: 2,
                      stats: {
                          filesMatched: 0,
                          fixedFiles: 0,
                          lintErrors: 0,
                          processingErrors: 1,
                          durationMs,
                      },
                  })
                : {
                      mode,
                      success: false,
                      concurrency,
                      filesMatched: 0,
                      fixedFiles: 0,
                      lintErrors: 0,
                      processingErrors: 1,
                      durationMs,
                      results: [errorResult],
                  };
            const reportOutput = JSON.stringify(reportPayload, null, 4);
            if (stdin) {
                console.error(reportOutput);
            } else {
                console.log(reportOutput);
            }
        } else {
            // Quiet mode already returned above; text mode always reports.
            console.error(colors.red(message));
        }
        process.exitCode = 2;
    }

    /**
     * Emits the final summary (JSON or text) and sets the process exit code.
     *
     * @param {object} stats - Aggregated run statistics.
     * @param {number} stats.filesMatched - Total files resolved by the glob.
     * @param {number} stats.fixCount - Files that were auto-fixed.
     * @param {number} stats.lintErrorCount - Files with formatting or semantic lint errors.
     * @param {number} stats.processingErrorCount - Files that caused I/O or read errors.
     * @param {number} stats.durationMs - Wall-clock elapsed time in milliseconds.
     */
    function exitWithReport({
        filesMatched,
        fixCount,
        lintErrorCount,
        processingErrorCount,
        durationMs,
    }) {
        const success = processingErrorCount === 0 && lintErrorCount === 0;

        if (quiet) {
            process.exitCode = processingErrorCount > 0 ? 2 : success ? 0 : 1;
            return;
        }

        if (useJsonReport) {
            console.log(
                JSON.stringify(
                    {
                        mode,
                        success,
                        concurrency,
                        filesMatched,
                        fixedFiles: fixCount,
                        lintErrors: lintErrorCount,
                        processingErrors: processingErrorCount,
                        durationMs,
                        results: results.map(publicJsonResult),
                    },
                    null,
                    4,
                ),
            );
            process.exitCode = processingErrorCount > 0 ? 2 : success ? 0 : 1;
            return;
        }

        if (useSarifReport) {
            const exitCode = processingErrorCount > 0 ? 2 : success ? 0 : 1;
            console.log(
                JSON.stringify(
                    createSarifReport({
                        results,
                        mode,
                        exitCode,
                        stats: {
                            filesMatched,
                            fixedFiles: fixCount,
                            lintErrors: lintErrorCount,
                            processingErrors: processingErrorCount,
                            durationMs,
                        },
                    }),
                    null,
                    4,
                ),
            );
            process.exitCode = exitCode;
            return;
        }

        if (fix) {
            if (processingErrorCount > 0) {
                console.error(
                    colors.red(
                        `\nSquirrelly Syntax Audit Failed: Encountered errors while processing ${processingErrorCount} files in ${durationMs}ms.`,
                    ),
                );
                process.exitCode = 2;
                return;
            }
            if (lintErrorCount > 0) {
                console.error(
                    colors.red(
                        `\nSquirrelly Syntax Audit Failed: ${lintErrorCount} files still have semantic errors after safe fixes (took ${durationMs}ms).`,
                    ),
                );
                process.exitCode = 1;
                return;
            }
            console.log(
                colors.green(
                    `\nSquirrelly Syntax Audit Complete: Fixed ${fixCount} files in ${colors.bold(durationMs + "ms")}.`,
                ),
            );
            return;
        }

        if (processingErrorCount > 0) {
            console.error(
                colors.red(
                    `\nSquirrelly Syntax Audit Failed: Encountered errors while processing ${processingErrorCount} files in ${durationMs}ms.`,
                ),
            );
            process.exitCode = 2;
        }
        if (lintErrorCount > 0) {
            console.error(
                colors.red(
                    `\nSquirrelly Syntax Audit Failed: ${lintErrorCount} files need formatting or have semantic errors. Run with --fix for safe repairs (took ${durationMs}ms).`,
                ),
            );
            process.exitCode = process.exitCode === 2 ? 2 : 1;
            return;
        }

        if (!processingErrorCount) {
            console.log(
                colors.green(
                    `\nSquirrelly Syntax Audit Passed: All files are formatted and semantically valid (${colors.bold(durationMs + "ms")}).`,
                ),
            );
        }
    }

    if (argumentError) {
        emitConfigurationError(argumentError.message);
        return;
    }

    if (!Number.isInteger(concurrency) || concurrency < 1) {
        emitConfigurationError("Invalid `--concurrency` value. Use an integer >= 1.");
        return;
    }

    if (concurrency > maxParallelism) {
        emitConfigurationError(
            `Invalid \`--concurrency\` value. Maximum is ${maxParallelism} (2\u00d7 available parallelism).`,
        );
        return;
    }

    let lintConfig;
    try {
        lintConfig = await loadLintOptions({ configPath });
    } catch (error) {
        emitConfigurationError(error instanceof Error ? error.message : String(error));
        return;
    }
    const resolveLintOptions = createLintOptionsResolver(lintConfig);

    /**
     * Stdin mode (`--stdin`): reads template content from stdin and writes
     * the formatted result to stdout.
     *
     * Designed for editor "format on save" integrations, shell pipelines,
     * and git pre-commit hooks. Diagnostic output (diffs, error messages)
     * is emitted to stderr so stdout remains a clean data channel.
     *
     * Exit codes follow the same convention as file mode:
     *   0 – content is clean, or `--fix` leaves no semantic errors
     *   1 – content needs formatting or has semantic errors
     *   2 – operational error (e.g. failed to read stdin)
     *
     * The `--stdin-filepath` option controls the filename displayed in
     * diff headers and error messages (defaults to "<stdin>").
     */
    if (stdin) {
        const filePath = stdinFilepath ?? "<stdin>";
        // Anonymous stdin has no project path and therefore receives only the
        // base configuration. An explicit virtual path opts into overrides.
        const lintOptions =
            stdinFilepath === undefined ? lintConfig.options : resolveLintOptions(stdinFilepath);
        if (process.stdin.isTTY) {
            emitConfigurationError(
                "Cannot read --stdin from an interactive terminal. Pipe template content to stdin.",
            );
            return;
        }

        let input;
        try {
            input = await readStdin();
        } catch (err) {
            emitConfigurationError(
                `Failed to read stdin: ${err instanceof Error ? err.message : String(err)}`,
            );
            return;
        }

        const initialLintResult = lintContent(input, lintOptions);
        const finalizedLintResult = fix
            ? lintContent(initialLintResult.content, lintOptions)
            : initialLintResult;
        const diagnostics = finalizedLintResult.diagnostics;
        const hasFormattingError = !fix && initialLintResult.changed;
        const hasLintError = hasFormattingError || diagnostics.length > 0;
        const status = resolveLintStatus({
            fix: Boolean(fix),
            changed: initialLintResult.changed,
            diagnosticCount: diagnostics.length,
        });
        const entry = {
            file: filePath,
            status,
            ...(diagnostics.length > 0 ? { diagnostics } : {}),
        };
        const formattingDiagnostic = hasFormattingError
            ? createFormattingDiagnostic(input, initialLintResult.content)
            : null;

        // Stdout remains the template data channel in every stdin mode.
        process.stdout.write(initialLintResult.content);

        if (useJsonReport && !quiet) {
            console.error(
                JSON.stringify(
                    {
                        mode,
                        success: !hasLintError,
                        concurrency: 1,
                        filesMatched: 1,
                        fixedFiles: fix && initialLintResult.changed ? 1 : 0,
                        lintErrors: hasLintError ? 1 : 0,
                        processingErrors: 0,
                        durationMs: Math.round(performance.now() - startTime),
                        results: [entry],
                    },
                    null,
                    4,
                ),
            );
        } else if (useSarifReport && !quiet) {
            const durationMs = Math.round(performance.now() - startTime);
            console.error(
                JSON.stringify(
                    createSarifReport({
                        results: [
                            {
                                ...entry,
                                ...(formattingDiagnostic ? { formattingDiagnostic } : {}),
                            },
                        ],
                        mode,
                        exitCode: hasLintError ? 1 : 0,
                        stats: {
                            filesMatched: 1,
                            fixedFiles: fix && initialLintResult.changed ? 1 : 0,
                            lintErrors: hasLintError ? 1 : 0,
                            processingErrors: 0,
                            durationMs,
                        },
                    }),
                    null,
                    4,
                ),
            );
        } else if (!quiet) {
            if (hasFormattingError) {
                if (diff) {
                    console.error(
                        createDiff({
                            filePath,
                            original: input,
                            formatted: initialLintResult.content,
                            colors,
                        }),
                    );
                } else {
                    console.error(
                        `${colors.red("Linting Error:")} ${filePath} is not formatted correctly.`,
                    );
                }
            }
            for (const finding of diagnostics) {
                console.error(
                    colors.red(
                        `${filePath}:${finding.line}:${finding.column} ${finding.message} [${finding.ruleId}]`,
                    ),
                );
            }
        }

        process.exitCode = hasLintError ? 1 : 0;
        return;
    }

    if (!globs || globs.length === 0) {
        emitConfigurationError("Please specify at least one glob pattern.");
        return;
    }

    if (concurrency > cpuCount && !quiet) {
        console.error(
            colors.gray(
                `Warning: --concurrency ${concurrency} exceeds available parallelism (${cpuCount}). Performance may degrade.`,
            ),
        );
    }

    const patterns = globs.map((pattern) => normalizeGlobPattern(pattern));
    const ignore = [
        "**/node_modules/**",
        ...(ignoredPatterns ?? []).map((pattern) => normalizeGlobPattern(pattern)),
    ];
    let files;
    try {
        files = (await fg(patterns, { absolute: true, ignore })).sort();
    } catch (error) {
        emitConfigurationError(
            `Failed to resolve glob patterns: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
    }
    if (files.length === 0) {
        emitConfigurationError("No files matched the provided pattern(s).");
        return;
    }

    const fileResults = new Array(files.length);
    let nextIndex = 0;

    /**
     * Reads a single file, runs the linter, and optionally writes the fix.
     * When in check mode with `--diff`, diffs are computed here so the full
     * file contents can be released immediately.
     *
     * @param {string} file - Absolute path to the `.sqrl` file.
     * @returns {Promise<{file: string, status: string, diff?: string, coloredDiff?: string, error?: string, diagnostics?: object[], formattingDiagnostic?: object}>}
     */
    async function processOneFile(file) {
        try {
            const originalContent = await fs.readFile(file, "utf8");
            const lintOptions = resolveLintOptions(file);
            const initialLintResult = lintContent(originalContent, lintOptions);

            if (fix && initialLintResult.changed) {
                await writeFileAtomically(file, initialLintResult.content);
            }

            const finalizedLintResult = fix
                ? lintContent(initialLintResult.content, lintOptions)
                : initialLintResult;
            const diagnostics = finalizedLintResult.diagnostics;

            if (fix) {
                return {
                    file,
                    status: resolveLintStatus({
                        fix: true,
                        changed: initialLintResult.changed,
                        diagnosticCount: diagnostics.length,
                    }),
                    ...(diagnostics.length > 0 ? { diagnostics } : {}),
                };
            }

            if (!initialLintResult.changed && diagnostics.length === 0) {
                return {
                    file,
                    status: "unchanged",
                };
            }

            const result = {
                file,
                status: resolveLintStatus({
                    fix: false,
                    changed: initialLintResult.changed,
                    diagnosticCount: diagnostics.length,
                }),
                ...(diagnostics.length > 0 ? { diagnostics } : {}),
                ...(initialLintResult.changed
                    ? {
                          formattingDiagnostic: createFormattingDiagnostic(
                              originalContent,
                              initialLintResult.content,
                          ),
                      }
                    : {}),
            };

            if (diff && initialLintResult.changed) {
                result.diff = createDiff({
                    filePath: file,
                    original: originalContent,
                    formatted: initialLintResult.content,
                    colors: noColors,
                });
                if (result.diff && !useMachineReport && !quiet) {
                    result.coloredDiff = createDiff({
                        filePath: file,
                        original: originalContent,
                        formatted: initialLintResult.content,
                        colors,
                    });
                }
            }

            return result;
        } catch (err) {
            return {
                file,
                status: "error",
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // Bounded-queue parallel processing: each worker claims the next file index
    // then awaits its processing. The shared nextIndex mutation is safe because
    // Node.js is single-threaded — only one worker reads/increments between awaits.
    const workerCount = Math.min(concurrency, files.length);
    await Promise.all(
        Array.from({ length: workerCount }, async () => {
            while (true) {
                const index = nextIndex;
                ++nextIndex;

                if (index >= files.length) {
                    return;
                }

                fileResults[index] = await processOneFile(files[index]);
            }
        }),
    );

    let lintErrorCount = 0;
    let processingErrorCount = 0;
    let fixCount = 0;

    for (const result of fileResults) {
        if (!result) {
            continue;
        }

        const entry = {
            file: result.file,
            status: result.status,
            ...(result.diff ? { diff: result.diff } : {}),
            ...(result.error ? { error: result.error } : {}),
            ...(result.diagnostics?.length ? { diagnostics: result.diagnostics } : {}),
            ...(result.formattingDiagnostic
                ? { formattingDiagnostic: result.formattingDiagnostic }
                : {}),
        };
        results.push(entry);

        if (result.status === "fixed" || result.status === "fixed-with-errors") {
            ++fixCount;
            if (!useMachineReport && !quiet) {
                console.log(`${colors.cyan("Formatted:")} ${result.file}`);
            }
        }

        if (
            result.status === "needs-formatting" ||
            result.status === "lint-error" ||
            result.status === "fixed-with-errors"
        ) {
            ++lintErrorCount;
            if (!useMachineReport && !quiet) {
                if (result.status === "needs-formatting") {
                    console.error(
                        `${colors.red("Linting Error:")} ${result.file} is not formatted correctly.`,
                    );
                }
                if (result.coloredDiff) {
                    console.error(result.coloredDiff);
                    console.error("");
                }
                for (const finding of result.diagnostics ?? []) {
                    console.error(
                        colors.red(
                            `${result.file}:${finding.line}:${finding.column} ${finding.message} [${finding.ruleId}]`,
                        ),
                    );
                }
            }
            continue;
        }

        if (result.status === "error") {
            ++processingErrorCount;
            if (!useMachineReport && !quiet) {
                console.error(`${colors.red("Error processing")} ${result.file}: ${result.error}`);
            }
        }
    }

    const durationMs = Math.round(performance.now() - startTime);
    return exitWithReport({
        filesMatched: files.length,
        fixCount,
        lintErrorCount,
        processingErrorCount,
        durationMs,
    });
}

/**
 * Checks whether this module is the invoked CLI entry point, resolving npm's
 * bin symlink before comparing it with this module's file path.
 *
 * @returns {Promise<boolean>} Whether the CLI should execute.
 */
async function isDirectInvocation() {
    if (!process.argv[1]) {
        return false;
    }
    try {
        const [entryPath, modulePath] = await Promise.all([
            fs.realpath(process.argv[1]),
            fs.realpath(fileURLToPath(import.meta.url)),
        ]);
        return entryPath === modulePath;
    } catch {
        return false;
    }
}

if (await isDirectInvocation()) {
    run().catch((err) => {
        console.error(err);
        process.exitCode = 2;
    });
}
