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

const colors = {
    red: (text) => `\x1b[31m${text}\x1b[0m`,
    green: (text) => `\x1b[32m${text}\x1b[0m`,
    cyan: (text) => `\x1b[36m${text}\x1b[0m`,
    gray: (text) => `\x1b[90m${text}\x1b[0m`,
    bold: (text) => `\x1b[1m${text}\x1b[0m`,
};

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
    .help()
    .parse();

async function run() {
    const startTime = performance.now();
    const globs = argv.globs;
    if (!globs || globs.length === 0) {
        console.error(colors.red("Please specify at least one glob pattern."));
        process.exit(1);
    }

    const files = await fg(globs, { absolute: true, ignore: ["**/node_modules/**"] });
    if (files.length === 0) {
        console.log(colors.gray("No files matched the provided pattern(s)."));
        process.exit(0);
    }

    let lintErrorCount = 0;
    let processingErrorCount = 0;
    let fixCount = 0;

    for (const file of files) {
        try {
            const originalContent = await fs.readFile(file, "utf8");
            const result = lintContent(originalContent);

            if (result.changed) {
                if (argv.fix) {
                    await fs.writeFile(file, result.content);
                    console.log(`${colors.cyan("Formatted:")} ${file}`);
                    fixCount++;
                } else {
                    console.error(
                        `${colors.red("Linting Error:")} ${file} is not formatted correctly.`,
                    );
                    lintErrorCount++;
                }
            }
        } catch (err) {
            console.error(`${colors.red("Error processing")} ${file}:`, err);
            processingErrorCount++;
        }
    }

    const durationMs = Math.round(performance.now() - startTime);

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
    process.exit(0);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
