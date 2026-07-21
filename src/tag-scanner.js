export const BLOCK_CLOSE_PATTERN = /^[ \t]*\/[ \t]*([A-Za-z_$][\w$.-]*)[ \t]*$/s;

/** Sentinel returned when a tag can be read as either a block close or a regex expression. */
export const AMBIGUOUS_CLOSE_DELIMITER = -2;

const REGEX_PREFIX_KEYWORDS = new Set([
    "await",
    "case",
    "delete",
    "do",
    "else",
    "in",
    "instanceof",
    "new",
    "of",
    "return",
    "throw",
    "typeof",
    "void",
    "yield",
]);

/**
 * Determine whether a slash can begin a JavaScript regular-expression literal.
 *
 * This is deliberately a lexical heuristic rather than a JavaScript parser. It
 * only decides whether delimiter-looking text inside a regex must be skipped.
 *
 * @param {string} source - Complete template source
 * @param {number} expressionStart - Start of the current JavaScript expression
 * @param {number} slashIndex - Index of the slash being classified
 * @returns {boolean} Whether the slash may open a regex literal
 */
export function canStartRegex(source, expressionStart, slashIndex) {
    let previousIndex = slashIndex - 1;
    while (previousIndex >= expressionStart && /\s/u.test(source[previousIndex])) {
        --previousIndex;
    }

    if (previousIndex < expressionStart) {
        return true;
    }

    const previousCharacter = source[previousIndex];
    if ("([{:;,=!?&|+-*%^~<>".includes(previousCharacter)) {
        return true;
    }

    if (/[A-Za-z_$]/u.test(previousCharacter)) {
        let wordStart = previousIndex;
        while (wordStart > expressionStart && /[\w$]/u.test(source[wordStart - 1])) {
            --wordStart;
        }

        return REGEX_PREFIX_KEYWORDS.has(source.slice(wordStart, previousIndex + 1));
    }

    return false;
}

/**
 * Skip a quoted JavaScript string.
 *
 * @param {string} source - Complete template source
 * @param {number} startIndex - Index of the opening quote
 * @param {string} quote - Quote character
 * @returns {number} Index immediately after the string, or the source length
 */
function skipQuotedString(source, startIndex, quote) {
    let cursor = startIndex + 1;

    while (cursor < source.length) {
        if (source[cursor] === "\\") {
            cursor += 2;
        } else if (source[cursor] === quote) {
            return cursor + 1;
        } else {
            ++cursor;
        }
    }

    return source.length;
}

/**
 * Skip a JavaScript block comment.
 *
 * @param {string} source - Complete template source
 * @param {number} startIndex - Index of the opening slash
 * @returns {number} Index immediately after the comment, or the source length
 */
function skipBlockComment(source, startIndex) {
    const closeIndex = source.indexOf("*/", startIndex + 2);
    return closeIndex === -1 ? source.length : closeIndex + 2;
}

/**
 * Skip a JavaScript line comment while leaving its terminating newline for the
 * caller to process.
 *
 * @param {string} source - Complete template source
 * @param {number} startIndex - Index of the opening slash
 * @returns {number} Index of the newline, or the source length
 */
function skipLineComment(source, startIndex) {
    const newlineIndex = source.indexOf("\n", startIndex + 2);
    return newlineIndex === -1 ? source.length : newlineIndex;
}

/**
 * Skip a JavaScript regular-expression literal, including character classes
 * and flags. If no closing slash exists, treat the slash as an operator.
 *
 * @param {string} source - Complete template source
 * @param {number} startIndex - Index of the opening slash
 * @returns {number} Index immediately after the regex, or just after the slash
 */
export function skipRegexLiteral(source, startIndex) {
    let cursor = startIndex + 1;
    let inCharacterClass = false;

    while (cursor < source.length) {
        const character = source[cursor];
        if (character === "\\") {
            cursor += 2;
            continue;
        }
        if (character === "\n" || character === "\r") {
            return startIndex + 1;
        }
        if (character === "[") {
            inCharacterClass = true;
        } else if (character === "]") {
            inCharacterClass = false;
        } else if (character === "/" && !inCharacterClass) {
            ++cursor;
            while (cursor < source.length && /[A-Za-z]/u.test(source[cursor])) {
                ++cursor;
            }
            return cursor;
        }
        ++cursor;
    }

    return startIndex + 1;
}

/**
 * Detect the narrow case where a block-close-looking prefix can also be the
 * start of a complete regular-expression literal whose body contains the
 * first delimiter candidate.
 *
 * A later `{{` before the prospective tag close indicates an adjacent tag,
 * not one ambiguous expression. In every other matching case, preserving the
 * input is safer than choosing either interpretation and corrupting the other.
 *
 * @param {string} source - Complete template source
 * @param {number} innerStart - Index immediately after the open delimiter
 * @param {number} firstCloseIndex - First delimiter-looking index
 * @param {string} closeDelimiter - Expected close delimiter
 * @returns {boolean} Whether the candidate is ambiguous and must pass through
 */
function isAmbiguousLeadingRegex(source, innerStart, firstCloseIndex, closeDelimiter) {
    let regexStart = innerStart;
    while (source[regexStart] === " " || source[regexStart] === "\t") {
        ++regexStart;
    }

    const regexEnd = skipRegexLiteral(source, regexStart);
    if (regexEnd <= firstCloseIndex + closeDelimiter.length) {
        return false;
    }

    const laterCloseIndex = source.indexOf(closeDelimiter, regexEnd);
    if (laterCloseIndex === -1) {
        return false;
    }

    const nextOpenIndex = source.indexOf("{{", firstCloseIndex + closeDelimiter.length);
    return nextOpenIndex === -1 || laterCloseIndex < nextOpenIndex;
}

/**
 * Skip a `${ ... }` expression within a template literal.
 *
 * @param {string} source - Complete template source
 * @param {number} startIndex - Index immediately after the opening `${`
 * @returns {number} Index immediately after the matching brace
 */
function skipTemplateExpression(source, startIndex) {
    let cursor = startIndex;
    let braceDepth = 1;

    while (cursor < source.length) {
        const character = source[cursor];
        const nextCharacter = source[cursor + 1];

        if (character === '"' || character === "'") {
            cursor = skipQuotedString(source, cursor, character);
        } else if (character === "`") {
            cursor = skipTemplateLiteral(source, cursor);
        } else if (character === "/" && nextCharacter === "*") {
            cursor = skipBlockComment(source, cursor);
        } else if (character === "/" && nextCharacter === "/") {
            cursor = skipLineComment(source, cursor);
        } else if (character === "/" && canStartRegex(source, startIndex, cursor)) {
            cursor = skipRegexLiteral(source, cursor);
        } else if (character === "{") {
            ++braceDepth;
            ++cursor;
        } else if (character === "}") {
            --braceDepth;
            ++cursor;
            if (braceDepth === 0) {
                return cursor;
            }
        } else {
            ++cursor;
        }
    }

    return source.length;
}

/**
 * Skip a JavaScript template literal, including nested `${ ... }`
 * expressions and nested template literals.
 *
 * @param {string} source - Complete template source
 * @param {number} startIndex - Index of the opening backtick
 * @returns {number} Index immediately after the template literal
 */
function skipTemplateLiteral(source, startIndex) {
    let cursor = startIndex + 1;

    while (cursor < source.length) {
        const character = source[cursor];
        if (character === "\\") {
            cursor += 2;
        } else if (character === "`") {
            return cursor + 1;
        } else if (character === "$" && source[cursor + 1] === "{") {
            cursor = skipTemplateExpression(source, cursor + 2);
        } else {
            ++cursor;
        }
    }

    return source.length;
}

/**
 * Find a tag's close delimiter without mistaking delimiter-looking text inside
 * JavaScript strings, comments, regular expressions, template literals, or
 * nested bracket pairs for the tag boundary.
 *
 * @param {string} source - Complete template source
 * @param {number} innerStart - Index immediately after the open delimiter
 * @param {string} closeDelimiter - Expected close delimiter
 * @returns {number} Start of the close delimiter, -1 when unclosed, or
 *   {@link AMBIGUOUS_CLOSE_DELIMITER} when choosing a boundary could corrupt
 *   either a block-close tag or a leading regex expression
 */
export function findCloseDelimiter(source, innerStart, closeDelimiter) {
    const firstCloseIndex = source.indexOf(closeDelimiter, innerStart);
    if (firstCloseIndex === -1) {
        return -1;
    }

    // A slash-prefixed block identifier is the one deliberate ambiguity with
    // a leading regex literal. Recognise the complete block-close grammar
    // before running JavaScript lexical classification.
    const isBlockCloseCandidate = BLOCK_CLOSE_PATTERN.test(source.slice(innerStart, firstCloseIndex));
    if (isBlockCloseCandidate && isAmbiguousLeadingRegex(source, innerStart, firstCloseIndex, closeDelimiter)) {
        return AMBIGUOUS_CLOSE_DELIMITER;
    }
    if (isBlockCloseCandidate) {
        return firstCloseIndex;
    }

    let cursor = innerStart;
    let braceDepth = 0;
    let bracketDepth = 0;
    let parenthesisDepth = 0;

    while (cursor < source.length) {
        if (
            braceDepth === 0 &&
            bracketDepth === 0 &&
            parenthesisDepth === 0 &&
            source.startsWith(closeDelimiter, cursor)
        ) {
            return cursor;
        }

        const character = source[cursor];
        const nextCharacter = source[cursor + 1];
        if (character === '"' || character === "'") {
            cursor = skipQuotedString(source, cursor, character);
        } else if (character === "`") {
            cursor = skipTemplateLiteral(source, cursor);
        } else if (character === "/" && nextCharacter === "*") {
            cursor = skipBlockComment(source, cursor);
        } else if (character === "/" && canStartRegex(source, innerStart, cursor)) {
            cursor = skipRegexLiteral(source, cursor);
        } else {
            if (character === "{") {
                ++braceDepth;
            } else if (character === "}" && braceDepth > 0) {
                --braceDepth;
            } else if (character === "[") {
                ++bracketDepth;
            } else if (character === "]" && bracketDepth > 0) {
                --bracketDepth;
            } else if (character === "(") {
                ++parenthesisDepth;
            } else if (character === ")" && parenthesisDepth > 0) {
                --parenthesisDepth;
            }
            ++cursor;
        }
    }

    return -1;
}

/**
 * Find JavaScript operators that Squirrelly sees at filter depth zero.
 *
 * Squirrelly only uses parenthesis depth when deciding whether `|` starts a
 * filter. Brackets and object literals therefore intentionally do not hide an
 * operator here. Quoted strings, block comments, template literals, and
 * parenthesised expressions do. Line comments and regex literals deliberately
 * remain visible because Squirrelly's own filter parser does not recognize
 * either construct.
 *
 * @param {string} source - JavaScript-like tag content
 * @param {string[]} operators - Operators to find, longest match wins
 * @returns {Array<{index: number, operator: string}>} Ordered matches
 */
export function findFilterDepthOperators(source, operators) {
    const candidates = [...new Set(operators)].sort((left, right) => right.length - left.length);
    const matches = [];
    let cursor = 0;
    let parenthesisDepth = 0;

    while (cursor < source.length) {
        const character = source[cursor];
        const nextCharacter = source[cursor + 1];

        if (character === '"' || character === "'") {
            cursor = skipQuotedString(source, cursor, character);
        } else if (character === "`") {
            cursor = skipTemplateLiteral(source, cursor);
        } else if (character === "/" && nextCharacter === "*") {
            cursor = skipBlockComment(source, cursor);
        } else if (character === "(") {
            ++parenthesisDepth;
            ++cursor;
        } else if (character === ")") {
            parenthesisDepth = Math.max(0, parenthesisDepth - 1);
            ++cursor;
        } else if (parenthesisDepth === 0) {
            const operator = candidates.find((candidate) => source.startsWith(candidate, cursor));
            if (operator) {
                matches.push({ index: cursor, operator });
                cursor += operator.length;
            } else {
                ++cursor;
            }
        } else {
            ++cursor;
        }
    }

    return matches;
}
