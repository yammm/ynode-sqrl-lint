import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import prettier from "prettier";

import * as sqrlPlugin from "../src/prettier-plugin.js";

const fixturesDir = path.resolve(process.cwd(), "tests", "fixtures");
const inputPath = path.join(fixturesDir, "prettier-input.sqrl");
const outputPath = path.join(fixturesDir, "prettier-output.sqrl");

test("prettier plugin formats fixture content to expected snapshot", async () => {
    const input = readFileSync(inputPath, "utf8");
    const expected = readFileSync(outputPath, "utf8");

    const actual = await prettier.format(input, {
        parser: "sqrl-parse",
        plugins: [sqrlPlugin],
    });

    assert.strictEqual(actual, expected);
});

test("prettier plugin formatting is idempotent", async () => {
    const expected = readFileSync(outputPath, "utf8");

    const actual = await prettier.format(expected, {
        parser: "sqrl-parse",
        plugins: [sqrlPlugin],
    });

    assert.strictEqual(actual, expected);
});
