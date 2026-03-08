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
 * Lints and fixes Squirrelly template syntax spacing.
 * @param originalContent - The raw file content
 * @returns The resulting formatted source and mutation state
 */
export function lintContent(originalContent: string): LintResult;
