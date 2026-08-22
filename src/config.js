import { readFile } from "node:fs/promises";
import path from "node:path";

/** Default configuration filename searched for in the working directory. */
export const CONFIG_FILENAME = ".sqrl-lintrc.json";

const DEFAULT_UNSAFE_RAW_FILTERS = Object.freeze([]);

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
]);

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
function validateConfig(parsed, configFilePath) {
    if (!isPlainObject(parsed)) {
        throw configError(configFilePath, "the top-level JSON value must be an object.");
    }

    for (const key of Object.keys(parsed)) {
        if (!SUPPORTED_KEYS.has(key)) {
            throw configError(configFilePath, `unknown option "${key}".`);
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
 * Loads lint options from an explicit JSON file or the conventional file in
 * the working directory. A missing conventional file is not an error.
 *
 * @param {object} [settings] - Configuration lookup settings.
 * @param {string} [settings.configPath] - Explicit configuration path, relative to `cwd` when needed.
 * @param {string} [settings.cwd=process.cwd()] - Directory used for implicit lookup and relative paths.
 * @returns {Promise<{options: Record<string, boolean | string | string[]>, path: string | undefined}>} Loaded options and source path.
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

    return {
        options: validateConfig(parsed, configFilePath),
        path: configFilePath,
    };
}
