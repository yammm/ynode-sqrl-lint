import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import prettier from "prettier";

import * as sqrlPlugin from "../src/prettier-plugin.js";

const fixturesDir = path.resolve(process.cwd(), "tests", "fixtures");
const inputPath = path.join(fixturesDir, "prettier-input.sqrl");
const outputPath = path.join(fixturesDir, "prettier-output.sqrl");

function format(text) {
    return prettier.format(text, {
        parser: "sqrl-parse",
        plugins: [sqrlPlugin],
    });
}

test("prettier plugin formats fixture content to expected snapshot", async () => {
    const input = readFileSync(inputPath, "utf8");
    const expected = readFileSync(outputPath, "utf8");

    const actual = await format(input);
    assert.strictEqual(actual, expected);
});

test("prettier plugin formatting is idempotent", async () => {
    const expected = readFileSync(outputPath, "utf8");

    const actual = await format(expected);
    assert.strictEqual(actual, expected);
});

test("prettier plugin handles empty files", async () => {
    const emptyPath = path.join(fixturesDir, "prettier-empty.sqrl");
    const input = readFileSync(emptyPath, "utf8");
    const actual = await format(input);
    assert.strictEqual(actual, input);
});

test("prettier plugin leaves plain text (no tags) unchanged", async () => {
    const plainPath = path.join(fixturesDir, "prettier-plain.sqrl");
    const input = readFileSync(plainPath, "utf8");
    const actual = await format(input);
    assert.strictEqual(actual, input);
});

test("prettier plugin formats all tag types correctly", async () => {
    const allTagsPath = path.join(fixturesDir, "prettier-all-tags.sqrl");
    const expectedPath = path.join(fixturesDir, "prettier-all-tags-expected.sqrl");
    const input = readFileSync(allTagsPath, "utf8");
    const expected = readFileSync(expectedPath, "utf8");

    const actual = await format(input);
    assert.strictEqual(actual, expected);
});

test("prettier plugin all-tags fixture is idempotent", async () => {
    const expectedPath = path.join(fixturesDir, "prettier-all-tags-expected.sqrl");
    const expected = readFileSync(expectedPath, "utf8");

    const actual = await format(expected);
    assert.strictEqual(actual, expected);
});
