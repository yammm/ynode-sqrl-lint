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
 * @type {Array<{name: string, pattern: RegExp, replacement: string}>}
 */
export const rules = [
    {
        // Self-closing helpers/macros: {{@ name() /}}
        name: "helper-self-closing",
        pattern: /^[ \t]*([@#!])[ \t]*(.*?)[ \t]*\/[ \t]*$/s,
        replacement: "$1 $2 /",
    },
    {
        // Helper/Macro open tags: {{@ name}}, {{# if()}}, {{! comment}}
        name: "helper-open",
        pattern: /^[ \t]*([@#!])[ \t]*(.*?)[ \t]*$/s,
        replacement: "$1 $2 ",
    },
    {
        // Closing block tags: {{/ if}}, {{/ extends}}
        name: "block-close",
        pattern: /^[ \t]*\/[ \t]*(.*?)[ \t]*$/s,
        replacement: "/ $1 ",
    },
    {
        // Standard expression tags: {{ foo }}, {{ bar.baz }}
        name: "expression",
        pattern: /^[ \t]*(.*?)[ \t]*$/s,
        replacement: " $1 ",
    },
];

/**
 * Normalise spacing inside a single Squirrelly tag's inner content.
 * Applies the first matching rule from the `rules` array.
 *
 * @param {string} inner - The text between the opening `{{` and closing `}}` delimiters.
 * @returns {string} The normalised inner content.
 */
function formatTagContent(inner) {
    for (const rule of rules) {
        if (rule.pattern.test(inner)) {
            return inner.replace(rule.pattern, rule.replacement);
        }
    }
    // No rule matched — return the content unchanged.
    return inner;
}

/**
 * Tag-aware scanner that finds Squirrelly tag boundaries and normalises
 * spacing only within those boundaries, leaving all surrounding content
 * (HTML, CSS, JS, plain text) completely untouched.
 *
 * Handles both double-brace `{{ ... }}` and triple-brace `{{{ ... }}}` tags.
 *
 * @param {string} originalContent - The raw file content
 * @returns {{changed: boolean, content: string}} The formatted source and mutation state
 */
export function lintContent(originalContent) {
    const len = originalContent.length;
    let result = "";
    let i = 0;

    while (i < len) {
        // Look for the start of a Squirrelly tag.
        if (originalContent[i] === "{" && i + 1 < len && originalContent[i + 1] === "{") {
            // Determine if this is a triple-brace tag.
            const isTriple = i + 2 < len && originalContent[i + 2] === "{";
            const openDelim = isTriple ? "{{{" : "{{";
            const closeDelim = isTriple ? "}}}" : "}}";
            const openLen = openDelim.length;
            const closeLen = closeDelim.length;

            // Find the matching close delimiter.
            const innerStart = i + openLen;
            const closeIndex = originalContent.indexOf(closeDelim, innerStart);

            if (closeIndex === -1) {
                // No matching close — emit the rest of the content as-is.
                result += originalContent.slice(i);
                break;
            }

            const inner = originalContent.slice(innerStart, closeIndex);
            let formattedInner;

            if (isTriple) {
                // Triple-brace: simple whitespace normalisation.
                formattedInner = " " + inner.trim() + " ";
            } else {
                formattedInner = formatTagContent(inner);
            }

            result += openDelim + formattedInner + closeDelim;
            i = closeIndex + closeLen;
        } else {
            result += originalContent[i];
            i++;
        }
    }

    return {
        changed: result !== originalContent,
        content: result,
    };
}
