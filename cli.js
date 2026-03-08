#!/usr/bin/env node

/**
 * The MIT License (MIT)
 * Copyright (c) 2026 Michael Welter <me@mikinho.com>
 */

import fs from "node:fs/promises";

import fg from "fast-glob";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { lintContent } from "./src/linter.js";

const ansiColors = {
    red: (text) => `\x1b[31m${text}\x1b[0m`,
    green: (text) => `\x1b[32m${text}\x1b[0m`,
    cyan: (text) => `\x1b[36m${text}\x1b[0m`,
    gray: (text) => `\x1b[90m${text}\x1b[0m`,
    bold: (text) => `\x1b[1m${text}\x1b[0m`,
};

function createColors(enabled) {
    if (!enabled) {
        return {
            red: (text) => text,
            green: (text) => text,
            cyan: (text) => text,
            gray: (text) => text,
            bold: (text) => text,
        };
    }
    return ansiColors;
}

const argv = yargs(hideBin(process.argv))
    .scriptName("sqrl-lint")
    .usage("$0 <globs...>", "Lint Squirrelly templates", (yargs) => {
        yargs.positional("globs", {
            describe: 'Glob patterns of files to lint (e.g., "**/*.sqrl")',
            type: "string",
            array: true,
        });
    })
    .example('$0 "**/*.sqrl"', "Check all .sqrl files for formatting issues")
    .example('$0 "**/*.sqrl" --fix', "Auto-repair formatting issues natively")
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
        default: true,
        description: "Enable ANSI color output for text reports",
    })
    .option("concurrency", {
        type: "number",
        default: 1,
        description: "Number of files to process in parallel (minimum 1)",
    })
    .help()
    .parse();

async function run() {
    const startTime = performance.now();
    const useJsonReport = argv.report === "json";
    const colors = createColors(argv.color && !useJsonReport);
    const globs = argv.globs;
    const concurrency = Number(argv.concurrency);

    const results = [];

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
            return process.exit(1);
        }

        console.error(colors.red(message));
        process.exit(1);
    }

    function exitWithReport({
        filesMatched,
        fixCount,
        lintErrorCount,
        processingErrorCount,
        durationMs,
    }) {
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
            return process.exit(success ? 0 : 1);
        }

        if (argv.fix) {
            if (processingErrorCount > 0) {
                console.error(
                    colors.red(
                        `\nSquirrelly Syntax Audit Failed: Encountered errors while processing ${processingErrorCount} files in ${durationMs}ms.`,
                    ),
                );
                return process.exit(1);
            }
            console.log(
                colors.green(
                    `\nSquirrelly Syntax Audit Complete: Fixed ${fixCount} files in ${colors.bold(durationMs + "ms")}.`,
                ),
            );
            return process.exit(0);
        }

        const totalErrors = lintErrorCount + processingErrorCount;
        if (totalErrors > 0) {
            if (processingErrorCount > 0) {
                console.error(
                    colors.red(
                        `\nSquirrelly Syntax Audit Failed: Encountered errors while processing ${processingErrorCount} files in ${durationMs}ms.`,
                    ),
                );
            }
            if (lintErrorCount > 0) {
                console.error(
                    colors.red(
                        `\nSquirrelly Syntax Audit Failed: ${lintErrorCount} files require formatting. Run with --fix to resolve (took ${durationMs}ms).`,
                    ),
                );
            }
            return process.exit(1);
        }

        console.log(
            colors.green(
                `\nSquirrelly Syntax Audit Passed: All files are formatted correctly (${colors.bold(durationMs + "ms")}).`,
            ),
        );
        return process.exit(0);
    }

    if (!globs || globs.length === 0) {
        emitConfigurationError("Please specify at least one glob pattern.");
    }

    if (!Number.isInteger(concurrency) || concurrency < 1) {
        emitConfigurationError("Invalid `--concurrency` value. Use an integer >= 1.");
    }

    const files = await fg(globs, { absolute: true, ignore: ["**/node_modules/**"] });
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
            return process.exit(0);
        }
        console.log(colors.gray("No files matched the provided pattern(s)."));
        process.exit(0);
    }

    const fileResults = new Array(files.length);
    let nextIndex = 0;

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

            return {
                file,
                status: "needs-formatting",
            };
        } catch (err) {
            return {
                file,
                status: "error",
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    const workerCount = Math.min(concurrency, files.length);
    await Promise.all(
        Array.from({ length: workerCount }, async () => {
            while (true) {
                const index = nextIndex;
                nextIndex++;

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
            fixCount++;
            results.push({ file: result.file, status: result.status });
            if (!useJsonReport) {
                console.log(`${colors.cyan("Formatted:")} ${result.file}`);
            }
            continue;
        }

        if (result.status === "needs-formatting") {
            lintErrorCount++;
            results.push({ file: result.file, status: result.status });
            if (!useJsonReport) {
                console.error(
                    `${colors.red("Linting Error:")} ${result.file} is not formatted correctly.`,
                );
            }
            continue;
        }

        processingErrorCount++;
        results.push({ file: result.file, status: result.status, error: result.error });
        if (!useJsonReport) {
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
    process.exit(1);
});
