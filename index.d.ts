/**
 * Interface representing the output of the Squirrelly formatting execution
 */
export interface LintResult {
    /**
     * True if the underlying source code was formatted and mutated
     */
    changed: boolean;
    /**
     * The finalized dynamically formatted text buffer
     */
    content: string;
    /** Semantic problems with locations anchored to the original input */
    diagnostics: LintDiagnostic[];
}

/** A semantic Squirrelly lint finding with a stable source location. */
export interface LintDiagnostic {
    /** Stable rule identifier suitable for CI integrations */
    ruleId: string;
    /** Current diagnostics are errors that cause the CLI to exit with code 1 */
    severity: "error";
    /** Human-readable explanation and remediation */
    message: string;
    /** Zero-based UTF-16 index in the original input */
    index: number;
    /** One-based line in the original input */
    line: number;
    /** One-based column in the original input */
    column: number;
    /** Whether `content` contains an automatic repair for this finding */
    fixable: boolean;
}

/** Optional semantic checks layered on top of the default formatter. */
export interface LintOptions {
    /** Compile the finalized source with Squirrelly. Defaults to true. */
    compile?: boolean;
    /** Compile with Squirrelly's async-template mode. Defaults to false. */
    async?: boolean;
    /** Repair exposed `||` by preserving it in parentheses or replacing it with `??`. */
    logicalOrFix?: "parenthesize" | "nullish";
    /** Complete project filter registry; enables unknown-filter diagnostics. */
    knownFilters?: readonly string[];
    /** Serializer filters that must not be emitted through raw output. */
    unsafeRawFilters?: readonly string[];
    /** Add an empty-string fallback to bare optional-chain output. */
    noImplicitNullOutput?: boolean;
    /** Reject JavaScript execution tags for restricted template surfaces. */
    forbidExecute?: boolean;
    /** Reject the `safe` filter for restricted template surfaces. */
    forbidSafe?: boolean;
}

/** Immutable default semantic lint options. */
export const DEFAULT_LINT_OPTIONS: Readonly<{
    compile: true;
    async: false;
    logicalOrFix: "parenthesize";
    unsafeRawFilters: readonly string[];
    noImplicitNullOutput: false;
    forbidExecute: false;
    forbidSafe: false;
}>;

/**
 * A declarative formatting rule applied to the content within Squirrelly tags.
 */
export interface LintRule {
    /** Human-readable identifier for the rule */
    name: string;
    /** Regex matched against the inner content of a tag (between delimiters) */
    pattern: RegExp;
    /** Replacement string (may reference capture groups) */
    replacement: string;
}

/**
 * Declarative formatting rules applied to content within Squirrelly tags.
 * Rules are evaluated in order; the first match wins for any given tag.
 */
export const rules: LintRule[];

/**
 * Lints and safely fixes Squirrelly template formatting and semantics.
 * @param originalContent - The raw file content
 * @param lintOptions - Optional semantic checks and project policy
 * @returns The resulting formatted source and mutation state
 */
export function lintContent(originalContent: string, lintOptions?: LintOptions): LintResult;
