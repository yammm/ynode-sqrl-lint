import { DEFAULT_LINT_OPTIONS } from "./config.js";
import {
    analyzeTemplateCompilation,
    analyzeTemplateSafety,
    fixTagSafety,
    getTagNesting,
    scanTemplateTags,
} from "./safety.js";
import { BLOCK_CLOSE_PATTERN } from "./tag-scanner.js";

export { DEFAULT_LINT_OPTIONS } from "./config.js";

/**
 * Declarative formatting rules applied to the content within Squirrelly tags.
 *
 * Each rule has:
 *  - `name`        – human-readable identifier
 *  - `pattern`     – regex matched against the *inner* content of a tag (between delimiters)
 *  - `replacement` – replacement string (may use capture groups)
 *
 * Rules are evaluated in order; the first match wins for any given tag.
 * Because rules only run on content inside `{{ ... }}` / `{{{ ... }}}` boundaries,
 * they can never produce false positives on surrounding HTML, CSS, or JS.
 *
 * The table is the declarative specification of the formatter. Its public
 * regular expressions and the linter's hand-written scan
 * ({@link applyFormattingRules}) both preserve linear-time matching on
 * pathological tag bodies. Every horizontal-whitespace quantifier is followed
 * by `(?![ \t])`, which makes that trim point effectively possessive: the
 * engine cannot redistribute the same whitespace among adjacent captures.
 *
 * @type {Array<{name: string, pattern: RegExp, replacement: string}>}
 */
export const rules = Object.freeze(
    [
        {
            // Self-closing helpers/macros: {{@ name() /}}
            //
            // Restricted to the `@` prefix — comment tags ({{! ... }}) and
            // block-open tags ({{# ... }}) are never self-closing, and a
            // trailing `/` inside their content is just part of the body
            // (most commonly the `*/` terminator of a `/* ... */` comment).
            // The prior `[@#!]` class let `{{! /* … */ }}` backtrack the
            // self-close slash onto the `*/` and split it.
            name: "helper-self-closing",
            pattern:
                /^[ \t]*(?![ \t])(@)[ \t]*(?![ \t])(.*[^ \t]|)[ \t]*(?![ \t])\/[ \t]*(?![ \t])$/s,
            replacement: "$1 $2 /",
        },
        {
            // Helper, branch, execution, and raw-output tags.
            name: "helper-open",
            pattern: /^[ \t]*(?![ \t])([@#!*])[ \t]*(?![ \t])(.*[^ \t]|)[ \t]*(?![ \t])$/s,
            replacement: "$1 $2 ",
        },
        {
            // Closing block tags: {{/ if}}, {{/ extends}}
            //
            // Restrict the body to a block identifier. A permissive `.*?`
            // classified leading regular-expression literals such as
            // `{{ /^admin/.test(role) }}` as block-close tags.
            name: "block-close",
            pattern: BLOCK_CLOSE_PATTERN,
            replacement: "/ $1 ",
        },
        {
            // Standard expression tags: {{ foo }}, {{ bar.baz }}
            name: "expression",
            pattern: /^[ \t]*(?![ \t])(.*[^ \t]|)[ \t]*(?![ \t])$/s,
            replacement: " $1 ",
        },
    ].map((rule) => Object.freeze(rule)),
);

/**
 * Apply the public declarative rule table in first-match order. The patterns
 * use effectively possessive whitespace trim points, so the exported API and
 * the built-in formatter now share one linear-time implementation.
 *
 * @param {string} content - Tag content without whitespace-control characters.
 * @returns {string} The normalised content.
 */
function applyFormattingRules(content) {
    for (const rule of rules) {
        if (rule.pattern.test(content)) {
            return content.replace(rule.pattern, rule.replacement);
        }
    }
    return content;
}

/**
 * Normalise spacing inside a single Squirrelly tag's inner content.
 * Applies the `rules` semantics — first matching rule wins.
 *
 * @param {string} inner - The text between the opening `{{` and closing `}}` delimiters.
 * @returns {string} The normalised inner content.
 */
function formatTagContent(inner) {
    const openingControl = inner[0] === "-" || inner[0] === "_" ? inner[0] : "";
    const contentStart = openingControl ? 1 : 0;
    const hasClosingControl =
        inner.length > contentStart && (inner.at(-1) === "-" || inner.at(-1) === "_");
    const closingControl = hasClosingControl ? inner.at(-1) : "";
    const contentEnd = hasClosingControl ? inner.length - 1 : inner.length;
    const content = inner.slice(contentStart, contentEnd);

    // Whitespace before `!` is semantically ambiguous: Squirrelly still sees
    // an execution prefix, while the author may have intended unary negation.
    // Preserve it so `--fix` cannot silently choose one interpretation.
    if (/^\s+!/u.test(content)) {
        return inner;
    }

    if (!/[\r\n]/u.test(content) && content.trim().length === 0) {
        return `${openingControl} ${closingControl}`;
    }

    const formatted = applyFormattingRules(content);

    // Do not add horizontal whitespace immediately before an opening
    // newline. `{{\nvalue\n}}` previously became `{{ \nvalue\n }}`,
    // creating trailing whitespace on the opening-delimiter line.
    const cleaned = formatted
        .replace(/^([@#!/*]?)[ \t]+(?=\r?\n)/u, "$1")
        .replace(/(\r?\n)[ \t]+$/u, "$1");
    return openingControl + cleaned + closingControl;
}

/**
 * Tag-aware scanner that finds Squirrelly tag boundaries and normalises
 * spacing only within those boundaries, leaving all surrounding content
 * (HTML, CSS, JS, plain text) completely untouched.
 *
 * Handles both double-brace `{{ ... }}` and triple-brace `{{{ ... }}}` tags.
 *
 * @param {string} originalContent - The raw file content
 * @param {object} [lintOptions] - Semantic lint options
 * @returns {{changed: boolean, content: string, diagnostics: object[]}} The formatted source, mutation state, and findings
 */
export function lintContent(originalContent, lintOptions = {}) {
    const options = {
        ...DEFAULT_LINT_OPTIONS,
        ...lintOptions,
        unsafeRawFilters: [
            ...(lintOptions.unsafeRawFilters ?? DEFAULT_LINT_OPTIONS.unsafeRawFilters),
        ],
        ...(lintOptions.knownFilters === undefined
            ? {}
            : { knownFilters: [...lintOptions.knownFilters] }),
    };
    /**
     * Collected output segments — joined once at the end.
     * @type {string[]}
     */
    const segments = [];
    const diagnostics = [];
    const helperStack = [];
    const scanResult = scanTemplateTags(originalContent);
    /** Start of the current plain-text run (characters outside any tag). */
    let plainStart = 0;

    for (const tag of scanResult.tags) {
        segments.push(originalContent.slice(plainStart, tag.start));
        const { inner, innerStart, isTriple } = tag;
        const openDelimiter = isTriple ? "{{{" : "{{";
        const closeDelimiter = isTriple ? "}}}" : "}}";
        const safetyResult = fixTagSafety({
            source: originalContent,
            inner,
            innerStart,
            isTriple,
            options,
            context: { parentHelper: helperStack.at(-1) },
        });
        diagnostics.push(...safetyResult.diagnostics);
        const formattedInner = formatTagContent(safetyResult.inner);
        const nesting = getTagNesting(safetyResult.inner, isTriple, options.async);
        if (nesting.close) {
            helperStack.pop();
        }
        if (nesting.open) {
            helperStack.push(nesting.open);
        }

        segments.push(openDelimiter + formattedInner + closeDelimiter);
        plainStart = tag.end;
    }
    // Includes the entire unresolved suffix after an ambiguous or unclosed tag.
    segments.push(originalContent.slice(plainStart));

    const result = segments.join("");
    diagnostics.push(...analyzeTemplateSafety({ source: originalContent, options, scanResult }));
    diagnostics.push(
        ...analyzeTemplateCompilation({
            originalSource: originalContent,
            finalizedSource: result,
            enabled: options.compile,
            asyncMode: options.async,
            unclosedIndex: scanResult.unclosedIndex,
        }),
    );
    diagnostics.sort(
        (left, right) => left.index - right.index || left.ruleId.localeCompare(right.ruleId),
    );

    return {
        changed: result !== originalContent,
        content: result,
        diagnostics,
    };
}
