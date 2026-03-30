#!/usr/bin/env node

/**
 * The MIT License (MIT)
 * Copyright (c) 2026 Michael Welter <me@mikinho.com>
 */

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";

import fg from "fast-glob";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { lintContent } from "./src/linter.js";

const require = createRequire(import.meta.url);
const { version } = require("./package.json");

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
 * Produces a minimal unified-style diff between two strings.
 * Only changed lines are shown, with surrounding context lines.
 *
 * @param {string} filePath - Path to display in the diff header.
 * @param {string} original - The original content.
 * @param {string} formatted - The formatted content.
 * @param {ReturnType<typeof createColors>} colors - Color helpers.
 * @param {number} [contextLines=3] - Number of unchanged context lines around each change.
 * @returns {string} The formatted diff output.
 */
function createDiff(filePath, original, formatted, colors, contextLines = 3) {
    const oldLines = original.split("\n");
    const newLines = formatted.split("\n");
    const output = [];

    output.push(colors.bold(`--- a/${filePath}`));
    output.push(colors.bold(`+++ b/${filePath}`));

    // Find changed line indices.
    const maxLen = Math.max(oldLines.length, newLines.length);
    const changed = [];
    for (let i = 0; i < maxLen; ++i) {
        if ((oldLines[i] ?? "") !== (newLines[i] ?? "")) {
            changed.push(i);
        }
    }

    if (changed.length === 0) {
        return "";
    }

    // Group nearby changes into unified diff hunks. Two changes merge into
    // one hunk when the gap between them is small enough that their context
    // windows (contextLines before + after each) would overlap or touch.
    // Threshold: gap <= contextLines * 2 + 1.
    const hunks = [];
    let hunkStart = changed[0];
    let hunkEnd = changed[0];
    for (let c = 1; c < changed.length; ++c) {
        if (changed[c] - hunkEnd <= contextLines * 2 + 1) {
            hunkEnd = changed[c];
        } else {
            hunks.push([hunkStart, hunkEnd]);
            hunkStart = changed[c];
            hunkEnd = changed[c];
        }
    }
    hunks.push([hunkStart, hunkEnd]);

    for (const [start, end] of hunks) {
        const ctxStart = Math.max(0, start - contextLines);
        const ctxEnd = Math.min(maxLen - 1, end + contextLines);

        // Count old-side and new-side lines independently.
        let oldCount = 0;
        let newCount = 0;
        const hunkLines = [];
        for (let i = ctxStart; i <= ctxEnd; ++i) {
            const oldLine = oldLines[i] ?? "";
            const newLine = newLines[i] ?? "";
            if (oldLine === newLine) {
                hunkLines.push(` ${oldLine}`);
                ++oldCount;
                ++newCount;
            } else {
                if (i < oldLines.length) {
                    hunkLines.push(colors.red(`-${oldLine}`));
                    ++oldCount;
                }
                if (i < newLines.length) {
                    hunkLines.push(colors.green(`+${newLine}`));
                    ++newCount;
                }
            }
        }

        output.push(colors.cyan(`@@ -${ctxStart + 1},${oldCount} +${ctxStart + 1},${newCount} @@`));
        output.push(...hunkLines);
    }

    return output.join("\n");
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

const argv = yargs(hideBin(process.argv))
    .scriptName("sqrl-lint")
    .usage("$0 [globs...]", "Lint Squirrelly templates", (yargs) => {
        yargs.positional("globs", {
            describe: 'Glob patterns of files to lint (e.g., "**/*.sqrl")',
            type: "string",
            array: true,
        });
    })
    .example('$0 "**/*.sqrl"', "Check all .sqrl files for formatting issues")
    .example('$0 "**/*.sqrl" --fix', "Auto-repair formatting issues natively")
    .example("cat file.sqrl | $0 --stdin", "Read from stdin and write formatted output to stdout")
    .option("stdin", {
        type: "boolean",
        description: "Read from stdin instead of file globs; formatted output is written to stdout",
    })
    .option("stdin-filepath", {
        type: "string",
        description: "Path to display in error messages and diffs when using --stdin",
        default: "<stdin>",
    })
    .option("fix", {
        alias: "f",
        type: "boolean",
        description: "Automatically fix formatting errors",
    })
    .option("report", {
        type: "string",
        choices: ["text", "json"],
        default: "text",
        description: "Output format",
    })
    .option("color", {
        type: "boolean",
        default: !("NO_COLOR" in process.env),
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
        description: "Suppress all output; only the exit code indicates pass (0) or fail (1/2)",
    })
    .option("ignore", {
        type: "string",
        array: true,
        description: 'Additional glob patterns to ignore (e.g., "**/vendor/**")',
    })
    .option("concurrency", {
        type: "number",
        default: 1,
        description: `Number of files to process in parallel (1–${maxParallelism})`,
    })
    .version(version)
    .help()
    .parse();

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
    const startTime = performance.now();
    const useJsonReport = argv.report === "json";
    const quiet = argv.quiet;
    const colors = createColors(argv.color && !useJsonReport && !quiet);
    const globs = argv.globs;
    const concurrency = Number(argv.concurrency);

    /** @type {Array<{file?: string, status: string, error?: string, diff?: string}>} */
    const results = [];

    /**
     * Exit codes:
     *   0 – success (all files clean, or all files fixed)
     *   1 – lint failure (one or more files need formatting)
     *   2 – operational error (I/O failures, invalid arguments, etc.)
     */

    /**
     * Emits an operational / configuration error via the active report
     * format (JSON or text) and sets exit code 2.
     *
     * @param {string} message - Human-readable error description.
     */
    function emitConfigurationError(message) {
        if (useJsonReport) {
            console.log(
                JSON.stringify(
                    {
                        mode: argv.fix ? "fix" : "check",
                        success: false,
                        concurrency,
                        filesMatched: 0,
                        fixedFiles: 0,
                        lintErrors: 0,
                        processingErrors: 1,
                        durationMs: Math.round(performance.now() - startTime),
                        results: [
                            {
                                status: "error",
                                error: message,
                            },
                        ],
                    },
                    null,
                    4,
                ),
            );
        } else if (!quiet) {
            console.error(colors.red(message));
        }
        process.exitCode = 2;
    }

    /**
     * Emits the final summary (JSON or text) and sets the process exit code.
     *
     * @param {Object} stats - Aggregated run statistics.
     * @param {number} stats.filesMatched - Total files resolved by the glob.
     * @param {number} stats.fixCount - Files that were auto-fixed.
     * @param {number} stats.lintErrorCount - Files that need formatting (check mode).
     * @param {number} stats.processingErrorCount - Files that caused I/O or read errors.
     * @param {number} stats.durationMs - Wall-clock elapsed time in milliseconds.
     */
    function exitWithReport({ filesMatched, fixCount, lintErrorCount, processingErrorCount, durationMs }) {
        const success = processingErrorCount === 0 && (argv.fix ? true : lintErrorCount === 0);

        if (useJsonReport) {
            console.log(
                JSON.stringify(
                    {
                        mode: argv.fix ? "fix" : "check",
                        success,
                        concurrency,
                        filesMatched,
                        fixedFiles: fixCount,
                        lintErrors: lintErrorCount,
                        processingErrors: processingErrorCount,
                        durationMs,
                        results,
                    },
                    null,
                    4,
                ),
            );
            process.exitCode = processingErrorCount > 0 ? 2 : success ? 0 : 1;
            return;
        }

        if (quiet) {
            process.exitCode = processingErrorCount > 0 ? 2 : success ? 0 : 1;
            return;
        }

        if (argv.fix) {
            if (processingErrorCount > 0) {
                console.error(
                    colors.red(
                        `\nSquirrelly Syntax Audit Failed: Encountered errors while processing ${processingErrorCount} files in ${durationMs}ms.`,
                    ),
                );
                process.exitCode = 2;
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
                    `\nSquirrelly Syntax Audit Failed: ${lintErrorCount} files require formatting. Run with --fix to resolve (took ${durationMs}ms).`,
                ),
            );
            process.exitCode = process.exitCode === 2 ? 2 : 1;
            return;
        }

        if (!processingErrorCount) {
            console.log(
                colors.green(
                    `\nSquirrelly Syntax Audit Passed: All files are formatted correctly (${colors.bold(durationMs + "ms")}).`,
                ),
            );
        }
    }

    /**
     * Stdin mode (`--stdin`): reads template content from stdin and writes
     * the formatted result to stdout.
     *
     * Designed for editor "format on save" integrations, shell pipelines,
     * and git pre-commit hooks. Diagnostic output (diffs, error messages)
     * is emitted to stderr so stdout remains a clean data channel.
     *
     * Exit codes follow the same convention as file mode:
     *   0 – content is already clean, or `--fix` was used
     *   1 – content needs formatting (check mode only)
     *   2 – operational error (e.g. failed to read stdin)
     *
     * The `--stdin-filepath` option controls the filename displayed in
     * diff headers and error messages (defaults to "<stdin>").
     */
    if (argv.stdin) {
        const filePath = argv.stdinFilepath ?? "<stdin>";
        let input;
        try {
            input = await readStdin();
        } catch (err) {
            emitConfigurationError(`Failed to read stdin: ${err instanceof Error ? err.message : String(err)}`);
            return;
        }

        const lintResult = lintContent(input);

        if (argv.fix) {
            // Fix mode: always write the formatted content to stdout.
            process.stdout.write(lintResult.content);
            if (useJsonReport) {
                const durationMs = Math.round(performance.now() - startTime);
                console.error(
                    JSON.stringify(
                        {
                            mode: "fix",
                            success: true,
                            file: filePath,
                            changed: lintResult.changed,
                            durationMs,
                        },
                        null,
                        4,
                    ),
                );
            }
            return;
        }

        // Check mode: if already clean, write as-is and exit 0.
        if (!lintResult.changed) {
            process.stdout.write(lintResult.content);
            if (useJsonReport) {
                const durationMs = Math.round(performance.now() - startTime);
                console.error(
                    JSON.stringify(
                        {
                            mode: "check",
                            success: true,
                            file: filePath,
                            changed: false,
                            durationMs,
                        },
                        null,
                        4,
                    ),
                );
            }
            return;
        }

        // Dirty: write formatted content to stdout, exit 1.
        process.stdout.write(lintResult.content);
        if (useJsonReport) {
            const durationMs = Math.round(performance.now() - startTime);
            console.error(
                JSON.stringify(
                    {
                        mode: "check",
                        success: false,
                        file: filePath,
                        changed: true,
                        durationMs,
                    },
                    null,
                    4,
                ),
            );
        } else if (!quiet && argv.diff) {
            console.error(createDiff(filePath, input, lintResult.content, colors));
        } else if (!quiet) {
            console.error(`${colors.red("Linting Error:")} ${filePath} is not formatted correctly.`);
        }
        process.exitCode = 1;
        return;
    }

    if (!globs || globs.length === 0) {
        emitConfigurationError("Please specify at least one glob pattern.");
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

    if (concurrency > cpuCount && !quiet) {
        console.error(
            colors.gray(
                `Warning: --concurrency ${concurrency} exceeds available parallelism (${cpuCount}). Performance may degrade.`,
            ),
        );
    }

    const ignore = ["**/node_modules/**", ...(argv.ignore ?? [])];
    const files = (await fg(globs, { absolute: true, ignore })).sort();
    if (files.length === 0) {
        const durationMs = Math.round(performance.now() - startTime);
        if (useJsonReport) {
            console.log(
                JSON.stringify(
                    {
                        mode: argv.fix ? "fix" : "check",
                        success: true,
                        concurrency,
                        filesMatched: 0,
                        fixedFiles: 0,
                        lintErrors: 0,
                        processingErrors: 0,
                        durationMs,
                        results: [],
                    },
                    null,
                    4,
                ),
            );
        } else if (!quiet) {
            console.log(colors.gray("No files matched the provided pattern(s)."));
        }
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
     * @returns {Promise<{file: string, status: string, diff?: string, coloredDiff?: string, error?: string}>}
     */
    async function processOneFile(file) {
        try {
            const originalContent = await fs.readFile(file, "utf8");
            const lintResult = lintContent(originalContent);

            if (!lintResult.changed) {
                return {
                    file,
                    status: "unchanged",
                };
            }

            if (argv.fix) {
                await fs.writeFile(file, lintResult.content);
                return {
                    file,
                    status: "fixed",
                };
            }

            const result = {
                file,
                status: "needs-formatting",
            };

            if (argv.diff) {
                result.diff = createDiff(file, originalContent, lintResult.content, noColors);
                if (result.diff && !useJsonReport && !quiet) {
                    result.coloredDiff = createDiff(file, originalContent, lintResult.content, colors);
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
        if (!result || result.status === "unchanged") {
            continue;
        }

        if (result.status === "fixed") {
            ++fixCount;
            results.push({ file: result.file, status: result.status });
            if (!useJsonReport && !quiet) {
                console.log(`${colors.cyan("Formatted:")} ${result.file}`);
            }
            continue;
        }

        if (result.status === "needs-formatting") {
            ++lintErrorCount;
            const entry = { file: result.file, status: result.status };
            if (result.diff) {
                entry.diff = result.diff;
            }
            results.push(entry);
            if (!useJsonReport && !quiet) {
                console.error(`${colors.red("Linting Error:")} ${result.file} is not formatted correctly.`);
                if (result.coloredDiff) {
                    console.error(result.coloredDiff);
                    console.error("");
                }
            }
            continue;
        }

        ++processingErrorCount;
        results.push({ file: result.file, status: result.status, error: result.error });
        if (!useJsonReport && !quiet) {
            console.error(`${colors.red("Error processing")} ${result.file}: ${result.error}`);
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

run().catch((err) => {
    console.error(err);
    process.exitCode = 2;
});
