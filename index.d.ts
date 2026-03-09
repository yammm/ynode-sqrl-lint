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
}

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
 * Lints and fixes Squirrelly template syntax spacing.
 * @param originalContent - The raw file content
 * @returns The resulting formatted source and mutation state
 */
export function lintContent(originalContent: string): LintResult;
