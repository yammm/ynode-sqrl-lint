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

const argv = yargs(hideBin(process.argv))
    .scriptName("sqrl-lint")
    .usage("$0 <globs...>", "Lint Squirrelly templates", (yargs) => {
        yargs.positional("globs", {
            describe: 'Glob patterns of files to lint (e.g., "**/*.sqrl")',
            type: "string",
            array: true,
        });
    })
    .option("fix", {
        alias: "f",
        type: "boolean",
        description: "Automatically fix formatting errors",
    })
    .help()
    .parse();

async function run() {
    const globs = argv.globs;
    if (!globs || globs.length === 0) {
        console.error("Please specify at least one glob pattern.");
        process.exit(1);
    }

    const files = await fg(globs, { absolute: true });
    if (files.length === 0) {
        console.log("No files matched the provided pattern(s).");
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
                    console.log(`Formatted: ${file}`);
                    fixCount++;
                } else {
                    console.error(`Linting Error: ${file} is not formatted correctly.`);
                    lintErrorCount++;
                }
            }
        } catch (err) {
            console.error(`Error processing ${file}:`, err);
            processingErrorCount++;
        }
    }

    if (argv.fix) {
        if (processingErrorCount > 0) {
            console.error(
                `\nSquirrelly Syntax Audit Failed: Encountered errors while processing ${processingErrorCount} files.`,
            );
            process.exit(1);
        }
        console.log(`\nSquirrelly Syntax Audit Complete: Fixed ${fixCount} files.`);
        process.exit(0);
    } else {
        const totalErrors = lintErrorCount + processingErrorCount;
        if (totalErrors > 0) {
            if (processingErrorCount > 0) {
                console.error(
                    `\nSquirrelly Syntax Audit Failed: Encountered errors while processing ${processingErrorCount} files.`,
                );
            }
            if (lintErrorCount > 0) {
                console.error(
                    `\nSquirrelly Syntax Audit Failed: ${lintErrorCount} files require formatting. Run with --fix to resolve.`,
                );
            }
            process.exit(1);
        } else {
            console.log(`\nSquirrelly Syntax Audit Passed: All files are formatted correctly.`);
            process.exit(0);
        }
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
