import { readFile } from "node:fs/promises";
import path from "node:path";

import picomatch from "picomatch";

/** Default configuration filename searched for in the working directory. */
export const CONFIG_FILENAME = ".sqrl-lintrc.json";

const DEFAULT_UNSAFE_RAW_FILTERS = Object.freeze([]);
const DEFAULT_OVERRIDES = Object.freeze([]);

/**
 * Default lint options. Array values and the containing object are immutable;
 * {@link loadLintOptions} returns independent copies for callers to extend.
 */
export const DEFAULT_LINT_OPTIONS = Object.freeze({
    compile: true,
    async: false,
    logicalOrFix: "parenthesize",
    unsafeRawFilters: DEFAULT_UNSAFE_RAW_FILTERS,
    noImplicitNullOutput: false,
    forbidExecute: false,
    forbidSafe: false,
});

const SUPPORTED_KEYS = new Set([
    "compile",
    "async",
    "logicalOrFix",
    "knownFilters",
    "unsafeRawFilters",
    "noImplicitNullOutput",
    "forbidExecute",
    "forbidSafe",
    "overrides",
]);

const LINT_OPTION_KEYS = new Set([...SUPPORTED_KEYS].filter((key) => key !== "overrides"));
const OVERRIDE_KEYS = new Set(["files", "excludedFiles", "options"]);

const BOOLEAN_KEYS = ["compile", "async", "noImplicitNullOutput", "forbidExecute", "forbidSafe"];
const FILTER_LIST_KEYS = ["knownFilters", "unsafeRawFilters"];
const LOGICAL_OR_FIX_VALUES = new Set(["parenthesize", "nullish"]);

/**
 * Creates an error that identifies the configuration file being loaded.
 *
 * @param {string} configFilePath - Absolute configuration file path.
 * @param {string} message - Validation or parsing failure description.
 * @param {unknown} [cause] - Optional originating error.
 * @returns {Error} A contextual configuration error.
 */
function configError(configFilePath, message, cause) {
    return new Error(`Invalid sqrl-lint configuration at ${configFilePath}: ${message}`, { cause });
}

/**
 * Returns whether a parsed JSON value is a plain object.
 *
 * @param {unknown} value - Parsed JSON value.
 * @returns {boolean} Whether the value is a plain object.
 */
function isPlainObject(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype
    );
}

/**
 * Validates and copies a configured list of filter names.
 *
 * @param {Record<string, unknown>} config - Parsed configuration object.
 * @param {string} key - Configuration property name.
 * @param {string} configFilePath - Absolute configuration file path.
 * @returns {string[] | undefined} A detached filter-name list when configured.
 */
function readFilterList(config, key, configFilePath) {
    if (!Object.hasOwn(config, key)) {
        return undefined;
    }

    const value = config[key];
    if (!Array.isArray(value)) {
        throw configError(configFilePath, `"${key}" must be an array of non-empty strings.`);
    }

    const names = [];
    const seen = new Set();
    for (const [index, name] of value.entries()) {
        if (typeof name !== "string" || name.trim().length === 0) {
            throw configError(configFilePath, `"${key}[${index}]" must be a non-empty string.`);
        }
        if (name !== name.trim()) {
            throw configError(
                configFilePath,
                `"${key}[${index}]" must not contain surrounding whitespace.`,
            );
        }
        if (!/^[A-Za-z_$][\w$.-]*$/u.test(name)) {
            throw configError(
                configFilePath,
                `"${key}[${index}]" must be a valid Squirrelly filter name.`,
            );
        }
        if (seen.has(name)) {
            throw configError(configFilePath, `"${key}" contains duplicate filter name "${name}".`);
        }
        seen.add(name);
        names.push(name);
    }

    return names;
}

/**
 * Strictly validates a parsed configuration and applies defaults.
 *
 * @param {unknown} parsed - Parsed JSON configuration.
 * @param {string} configFilePath - Absolute configuration file path.
 * @returns {Record<string, boolean | string | string[]>} Validated lint options.
 */
function validateLintOptions(parsed, configFilePath, { context = "configuration" } = {}) {
    if (!isPlainObject(parsed)) {
        throw configError(configFilePath, `${context} must be an object.`);
    }

    for (const key of Object.keys(parsed)) {
        if (!LINT_OPTION_KEYS.has(key)) {
            throw configError(configFilePath, `${context} contains unknown option "${key}".`);
        }
    }

    for (const key of BOOLEAN_KEYS) {
        if (Object.hasOwn(parsed, key) && typeof parsed[key] !== "boolean") {
            throw configError(configFilePath, `"${key}" must be a boolean.`);
        }
    }

    if (
        Object.hasOwn(parsed, "logicalOrFix") &&
        (typeof parsed.logicalOrFix !== "string" || !LOGICAL_OR_FIX_VALUES.has(parsed.logicalOrFix))
    ) {
        throw configError(
            configFilePath,
            '"logicalOrFix" must be either "parenthesize" or "nullish".',
        );
    }

    const knownFilters = readFilterList(parsed, FILTER_LIST_KEYS[0], configFilePath);
    const unsafeRawFilters = readFilterList(parsed, FILTER_LIST_KEYS[1], configFilePath);
    const options = {
        compile: parsed.compile ?? DEFAULT_LINT_OPTIONS.compile,
        async: parsed.async ?? DEFAULT_LINT_OPTIONS.async,
        logicalOrFix: parsed.logicalOrFix ?? DEFAULT_LINT_OPTIONS.logicalOrFix,
        unsafeRawFilters: unsafeRawFilters ?? [...DEFAULT_LINT_OPTIONS.unsafeRawFilters],
        noImplicitNullOutput:
            parsed.noImplicitNullOutput ?? DEFAULT_LINT_OPTIONS.noImplicitNullOutput,
        forbidExecute: parsed.forbidExecute ?? DEFAULT_LINT_OPTIONS.forbidExecute,
        forbidSafe: parsed.forbidSafe ?? DEFAULT_LINT_OPTIONS.forbidSafe,
    };

    if (knownFilters !== undefined) {
        options.knownFilters = knownFilters;
    }

    return options;
}

/**
 * Validates and copies one override glob field.
 *
 * Config patterns always use forward slashes and are evaluated relative to the
 * CLI working directory. Negation belongs in `excludedFiles`, which keeps
 * ordered override precedence unambiguous.
 *
 * @param {Record<string, unknown>} override - Parsed override entry.
 * @param {"files"|"excludedFiles"} key - Override property to read.
 * @param {string} configFilePath - Absolute configuration file path.
 * @param {number} overrideIndex - Zero-based override index.
 * @param {boolean} required - Whether at least one pattern is required.
 * @returns {string[]} Detached glob pattern list.
 */
function readOverridePatterns(override, key, configFilePath, overrideIndex, required) {
    if (!Object.hasOwn(override, key)) {
        if (required) {
            throw configError(configFilePath, `"overrides[${overrideIndex}].${key}" is required.`);
        }
        return [];
    }

    const raw = override[key];
    const patterns = typeof raw === "string" ? [raw] : raw;
    if (!Array.isArray(patterns) || (required && patterns.length === 0)) {
        throw configError(
            configFilePath,
            `"overrides[${overrideIndex}].${key}" must be ${required ? "a non-empty string or array of strings" : "a string or array of strings"}.`,
        );
    }

    return patterns.map((pattern, patternIndex) => {
        const label = `overrides[${overrideIndex}].${key}[${patternIndex}]`;
        if (typeof pattern !== "string" || pattern.length === 0) {
            throw configError(configFilePath, `"${label}" must be a non-empty string.`);
        }
        if (pattern !== pattern.trim()) {
            throw configError(
                configFilePath,
                `"${label}" must not contain surrounding whitespace.`,
            );
        }
        if (pattern.startsWith("!")) {
            throw configError(
                configFilePath,
                `"${label}" must not be negated; use "excludedFiles" instead.`,
            );
        }
        if (pattern.includes("\\")) {
            throw configError(
                configFilePath,
                `"${label}" must use forward slashes as path separators.`,
            );
        }
        if (path.posix.isAbsolute(pattern) || path.win32.isAbsolute(pattern)) {
            throw configError(
                configFilePath,
                `"${label}" must be relative to the lint working directory.`,
            );
        }
        try {
            picomatch.makeRe(pattern);
        } catch (error) {
            throw configError(
                configFilePath,
                `"${label}" is not a valid glob pattern (${error.message}).`,
                error,
            );
        }
        return pattern;
    });
}

/**
 * Validates ordered per-glob lint option overrides.
 *
 * @param {unknown} rawOverrides - Parsed `overrides` value.
 * @param {string} configFilePath - Absolute configuration file path.
 * @returns {Array<{files: string[], excludedFiles: string[], options: Record<string, boolean|string|string[]>}>} Validated overrides.
 */
function validateOverrides(rawOverrides, configFilePath) {
    if (rawOverrides === undefined) {
        return [];
    }
    if (!Array.isArray(rawOverrides)) {
        throw configError(configFilePath, '"overrides" must be an array.');
    }

    return rawOverrides.map((override, overrideIndex) => {
        if (!isPlainObject(override)) {
            throw configError(configFilePath, `"overrides[${overrideIndex}]" must be an object.`);
        }
        for (const key of Object.keys(override)) {
            if (!OVERRIDE_KEYS.has(key)) {
                throw configError(
                    configFilePath,
                    `"overrides[${overrideIndex}]" contains unknown property "${key}".`,
                );
            }
        }

        const files = readOverridePatterns(override, "files", configFilePath, overrideIndex, true);
        const excludedFiles = readOverridePatterns(
            override,
            "excludedFiles",
            configFilePath,
            overrideIndex,
            false,
        );
        if (!Object.hasOwn(override, "options")) {
            throw configError(configFilePath, `"overrides[${overrideIndex}].options" is required.`);
        }
        const options = validateLintOptions(override.options, configFilePath, {
            context: `"overrides[${overrideIndex}].options"`,
        });

        // Override entries are partial. Remove defaults for keys the entry did
        // not explicitly provide so base settings and earlier matches survive.
        for (const key of LINT_OPTION_KEYS) {
            if (!Object.hasOwn(override.options, key)) {
                delete options[key];
            }
        }

        return { files, excludedFiles, options };
    });
}

/**
 * Strictly validates a parsed configuration and applies base defaults.
 *
 * @param {unknown} parsed - Parsed JSON configuration.
 * @param {string} configFilePath - Absolute configuration file path.
 * @returns {{options: Record<string, boolean|string|string[]>, overrides: Array<{files: string[], excludedFiles: string[], options: Record<string, boolean|string|string[]>}>}} Validated configuration.
 */
function validateConfig(parsed, configFilePath) {
    if (!isPlainObject(parsed)) {
        throw configError(configFilePath, "the top-level JSON value must be an object.");
    }
    for (const key of Object.keys(parsed)) {
        if (!SUPPORTED_KEYS.has(key)) {
            throw configError(configFilePath, `unknown option "${key}".`);
        }
    }

    const baseInput = Object.fromEntries(
        Object.entries(parsed).filter(([key]) => key !== "overrides"),
    );
    return {
        options: validateLintOptions(baseInput, configFilePath),
        overrides: validateOverrides(parsed.overrides, configFilePath),
    };
}

/**
 * Creates a per-path lint option resolver. Override globs are matched against a
 * forward-slash, working-directory-relative path. Matching entries are applied
 * in declaration order, so later entries deterministically win.
 *
 * @param {{options: Record<string, boolean|string|string[]>, overrides?: Array<{files: string[], excludedFiles?: string[], options: Record<string, boolean|string|string[]>}>}} config - Loaded lint configuration.
 * @param {object} [settings] - Resolver settings.
 * @param {string} [settings.cwd=process.cwd()] - Base directory for file paths and override globs.
 * @returns {(filePath: string) => Record<string, boolean|string|string[]>} Per-file option resolver.
 */
export function createLintOptionsResolver(config, { cwd = process.cwd() } = {}) {
    const resolvedCwd = path.resolve(cwd);
    const preparedOverrides = (config.overrides ?? DEFAULT_OVERRIDES).map((override) => ({
        options: override.options,
        matches: picomatch(override.files, { dot: true }),
        excluded:
            override.excludedFiles?.length > 0
                ? picomatch(override.excludedFiles, { dot: true })
                : () => false,
    }));

    return (filePath) => {
        const absolutePath = path.resolve(resolvedCwd, filePath);
        const relativePath = path.relative(resolvedCwd, absolutePath).split(path.sep).join("/");
        const outsideCwd = relativePath === ".." || relativePath.startsWith("../");
        const options = {
            ...config.options,
            unsafeRawFilters: [...(config.options.unsafeRawFilters ?? [])],
            ...(config.options.knownFilters === undefined
                ? {}
                : { knownFilters: [...config.options.knownFilters] }),
        };

        if (outsideCwd) {
            return options;
        }
        for (const override of preparedOverrides) {
            if (!override.matches(relativePath) || override.excluded(relativePath)) {
                continue;
            }
            Object.assign(options, override.options);
            if (override.options.unsafeRawFilters !== undefined) {
                options.unsafeRawFilters = [...override.options.unsafeRawFilters];
            }
            if (override.options.knownFilters !== undefined) {
                options.knownFilters = [...override.options.knownFilters];
            }
        }
        return options;
    };
}

/**
 * Loads lint options from an explicit JSON file or the conventional file in
 * the working directory. A missing conventional file is not an error.
 *
 * @param {object} [settings] - Configuration lookup settings.
 * @param {string} [settings.configPath] - Explicit configuration path, relative to `cwd` when needed.
 * @param {string} [settings.cwd=process.cwd()] - Directory used for implicit lookup and relative paths.
 * @returns {Promise<{options: Record<string, boolean | string | string[]>, overrides: Array<{files: string[], excludedFiles: string[], options: Record<string, boolean|string|string[]>}>, path: string | undefined}>} Loaded options, ordered overrides, and source path.
 */
export async function loadLintOptions({ configPath, cwd = process.cwd() } = {}) {
    const isExplicit = configPath !== undefined;
    const configFilePath = path.resolve(cwd, isExplicit ? configPath : CONFIG_FILENAME);

    let source;
    try {
        source = await readFile(configFilePath, "utf8");
    } catch (error) {
        if (!isExplicit && error?.code === "ENOENT") {
            return {
                options: {
                    compile: DEFAULT_LINT_OPTIONS.compile,
                    async: DEFAULT_LINT_OPTIONS.async,
                    logicalOrFix: DEFAULT_LINT_OPTIONS.logicalOrFix,
                    unsafeRawFilters: [...DEFAULT_LINT_OPTIONS.unsafeRawFilters],
                    noImplicitNullOutput: DEFAULT_LINT_OPTIONS.noImplicitNullOutput,
                    forbidExecute: DEFAULT_LINT_OPTIONS.forbidExecute,
                    forbidSafe: DEFAULT_LINT_OPTIONS.forbidSafe,
                },
                overrides: [],
                path: undefined,
            };
        }
        throw configError(configFilePath, `could not read file (${error.message}).`, error);
    }

    let parsed;
    try {
        parsed = JSON.parse(source);
    } catch (error) {
        throw configError(configFilePath, `invalid JSON (${error.message}).`, error);
    }

    const config = validateConfig(parsed, configFilePath);
    return {
        ...config,
        path: configFilePath,
    };
}
