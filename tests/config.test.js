import assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CONFIG_FILENAME, DEFAULT_LINT_OPTIONS, loadLintOptions } from "../src/config.js";

async function makeTempDir() {
    return mkdtemp(path.join(tmpdir(), "sqrl-lint-config-test-"));
}

async function withTempDir(callback) {
    const directory = await makeTempDir();
    try {
        await callback(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

async function writeConfig(directory, value, filename = CONFIG_FILENAME) {
    const configPath = path.join(directory, filename);
    await writeFile(configPath, JSON.stringify(value), "utf8");
    return configPath;
}

test("exports deeply immutable defaults", () => {
    assert.strictEqual(Object.isFrozen(DEFAULT_LINT_OPTIONS), true);
    assert.strictEqual(Object.isFrozen(DEFAULT_LINT_OPTIONS.unsafeRawFilters), true);
    assert.deepStrictEqual(DEFAULT_LINT_OPTIONS, {
        compile: true,
        async: false,
        logicalOrFix: "parenthesize",
        unsafeRawFilters: [],
        noImplicitNullOutput: false,
        forbidExecute: false,
        forbidSafe: false,
    });
    assert.strictEqual(Object.hasOwn(DEFAULT_LINT_OPTIONS, "knownFilters"), false);
});

test("a missing implicit config returns detached defaults and no path", async () => {
    await withTempDir(async (directory) => {
        const first = await loadLintOptions({ cwd: directory });
        const second = await loadLintOptions({ cwd: directory });

        assert.strictEqual(first.path, undefined);
        assert.deepStrictEqual(first.options, DEFAULT_LINT_OPTIONS);
        assert.notStrictEqual(first.options, DEFAULT_LINT_OPTIONS);
        assert.notStrictEqual(first.options, second.options);
        assert.notStrictEqual(first.options.unsafeRawFilters, second.options.unsafeRawFilters);

        first.options.unsafeRawFilters.push("json");
        assert.deepStrictEqual(second.options.unsafeRawFilters, []);
        assert.deepStrictEqual(DEFAULT_LINT_OPTIONS.unsafeRawFilters, []);
    });
});

test("loads the conventional config and applies defaults", async () => {
    await withTempDir(async (directory) => {
        const configPath = await writeConfig(directory, {
            compile: false,
            async: true,
            logicalOrFix: "nullish",
            knownFilters: ["date", "scriptJson"],
            unsafeRawFilters: ["json"],
            forbidExecute: true,
        });

        const result = await loadLintOptions({ cwd: directory });
        assert.strictEqual(result.path, configPath);
        assert.deepStrictEqual(result.options, {
            compile: false,
            async: true,
            logicalOrFix: "nullish",
            knownFilters: ["date", "scriptJson"],
            unsafeRawFilters: ["json"],
            noImplicitNullOutput: false,
            forbidExecute: true,
            forbidSafe: false,
        });
    });
});

test("loads an explicit path relative to cwd", async () => {
    await withTempDir(async (directory) => {
        const configPath = await writeConfig(
            directory,
            { noImplicitNullOutput: true, forbidSafe: true },
            "custom.json",
        );
        const result = await loadLintOptions({ cwd: directory, configPath: "custom.json" });

        assert.strictEqual(result.path, configPath);
        assert.deepStrictEqual(result.options, {
            compile: true,
            async: false,
            logicalOrFix: "parenthesize",
            unsafeRawFilters: [],
            noImplicitNullOutput: true,
            forbidExecute: false,
            forbidSafe: true,
        });
    });
});

test("accepts empty filter lists and copies configured arrays", async () => {
    await withTempDir(async (directory) => {
        const configPath = await writeConfig(directory, { knownFilters: [], unsafeRawFilters: [] });
        const first = await loadLintOptions({ configPath });
        const second = await loadLintOptions({ configPath });

        assert.deepStrictEqual(first.options.knownFilters, []);
        assert.notStrictEqual(first.options.knownFilters, second.options.knownFilters);
        assert.notStrictEqual(first.options.unsafeRawFilters, second.options.unsafeRawFilters);
    });
});

test("a missing explicit config is an error that includes its resolved path", async () => {
    await withTempDir(async (directory) => {
        const expectedPath = path.join(directory, "missing.json");
        await assert.rejects(
            loadLintOptions({ cwd: directory, configPath: "missing.json" }),
            (error) =>
                error.message.includes(expectedPath) && /could not read file/u.test(error.message),
        );
    });
});

test("rejects malformed JSON with the config path", async () => {
    await withTempDir(async (directory) => {
        const configPath = path.join(directory, CONFIG_FILENAME);
        await writeFile(configPath, '{"compile": true', "utf8");
        await assert.rejects(
            loadLintOptions({ cwd: directory }),
            (error) => error.message.includes(configPath) && /invalid JSON/u.test(error.message),
        );
    });
});

test("rejects non-object top-level JSON values", async (t) => {
    for (const value of [null, [], true, "config", 1]) {
        await t.test(JSON.stringify(value), async () => {
            await withTempDir(async (directory) => {
                const configPath = await writeConfig(directory, value);
                await assert.rejects(
                    loadLintOptions({ cwd: directory }),
                    (error) =>
                        error.message.includes(configPath) &&
                        /top-level JSON value must be an object/u.test(error.message),
                );
            });
        });
    }
});

test("rejects unknown options", async () => {
    await withTempDir(async (directory) => {
        const configPath = await writeConfig(directory, { compile: true, typo: false });
        await assert.rejects(
            loadLintOptions({ cwd: directory }),
            (error) =>
                error.message.includes(configPath) && /unknown option "typo"/u.test(error.message),
        );
    });
});

test("rejects non-boolean boolean options", async (t) => {
    for (const key of ["compile", "async", "noImplicitNullOutput", "forbidExecute", "forbidSafe"]) {
        await t.test(key, async () => {
            await withTempDir(async (directory) => {
                const configPath = await writeConfig(directory, { [key]: 1 });
                await assert.rejects(
                    loadLintOptions({ cwd: directory }),
                    (error) =>
                        error.message.includes(configPath) &&
                        error.message.includes(`"${key}" must be a boolean`),
                );
            });
        });
    }
});

test("rejects invalid logical-OR fix strategies", async (t) => {
    for (const value of [true, "replace", "NULLISH", null]) {
        await t.test(String(value), async () => {
            await withTempDir(async (directory) => {
                const configPath = await writeConfig(directory, { logicalOrFix: value });
                await assert.rejects(
                    loadLintOptions({ cwd: directory }),
                    (error) =>
                        error.message.includes(configPath) &&
                        /"logicalOrFix" must be either "parenthesize" or "nullish"/u.test(
                            error.message,
                        ),
                );
            });
        });
    }
});

test("rejects invalid filter list shapes and entries", async (t) => {
    const cases = [
        [
            "knownFilters must be an array",
            { knownFilters: "date" },
            /"knownFilters" must be an array/u,
        ],
        [
            "unsafe filters must be an array",
            { unsafeRawFilters: {} },
            /"unsafeRawFilters" must be an array/u,
        ],
        [
            "filter names must be strings",
            { knownFilters: [1] },
            /"knownFilters\[0\]" must be a non-empty string/u,
        ],
        ["empty names are invalid", { unsafeRawFilters: [""] }, /must be a non-empty string/u],
        [
            "whitespace-only names are invalid",
            { knownFilters: ["  "] },
            /must be a non-empty string/u,
        ],
        [
            "surrounding whitespace is invalid",
            { knownFilters: [" date "] },
            /surrounding whitespace/u,
        ],
        [
            "filter syntax is validated",
            { knownFilters: ["date input"] },
            /valid Squirrelly filter name/u,
        ],
    ];

    for (const [name, value, messagePattern] of cases) {
        await t.test(name, async () => {
            await withTempDir(async (directory) => {
                const configPath = await writeConfig(directory, value);
                await assert.rejects(
                    loadLintOptions({ cwd: directory }),
                    (error) =>
                        error.message.includes(configPath) && messagePattern.test(error.message),
                );
            });
        });
    }
});

test("rejects duplicate names independently in each filter list", async (t) => {
    for (const key of ["knownFilters", "unsafeRawFilters"]) {
        await t.test(key, async () => {
            await withTempDir(async (directory) => {
                const configPath = await writeConfig(directory, { [key]: ["json", "json"] });
                await assert.rejects(
                    loadLintOptions({ cwd: directory }),
                    (error) =>
                        error.message.includes(configPath) &&
                        /duplicate filter name "json"/u.test(error.message),
                );
            });
        });
    }
});
