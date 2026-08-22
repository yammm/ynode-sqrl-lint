import { parseExpressionAt, tokenizer } from "acorn";
import { compile as compileTemplate } from "squirrelly";

import {
    AMBIGUOUS_CLOSE_DELIMITER,
    BLOCK_CLOSE_PATTERN,
    canStartRegex,
    findCloseDelimiter,
    findFilterDepthOperators,
    skipRegexLiteral,
} from "./tag-scanner.js";

const TAG_PREFIXES = new Set(["@", "#", "!", "*", "/"]);
const BUILT_IN_FILTERS = new Set(["e"]);

/**
 * Convert an absolute source index into a one-based line and column.
 *
 * @param {string} source - Complete template source
 * @param {number} index - Zero-based source index
 * @returns {{line: number, column: number}}
 */
function locate(source, index) {
    let line = 1;
    let column = 1;

    for (let cursor = 0; cursor < Math.min(index, source.length); ++cursor) {
        if (source[cursor] === "\n") {
            ++line;
            column = 1;
        } else {
            ++column;
        }
    }

    return { line, column };
}

/**
 * Build a stable, machine-readable lint diagnostic.
 *
 * @param {string} source - Complete template source
 * @param {number} index - Zero-based source index
 * @param {string} ruleId - Stable rule identifier
 * @param {string} message - Human-readable explanation
 * @param {boolean} [fixable=false] - Whether the returned content contains an automatic fix
 * @returns {{ruleId: string, severity: "error", message: string, index: number, line: number, column: number, fixable: boolean}}
 */
function diagnostic(source, index, ruleId, message, fixable = false) {
    return {
        ruleId,
        severity: "error",
        message,
        index,
        ...locate(source, index),
        fixable,
    };
}

/**
 * Describe the syntactic portions of a Squirrelly tag body.
 *
 * @param {string} inner - Text between the tag delimiters
 * @param {boolean} isTriple - Whether the tag used triple braces
 * @returns {{prefix: string, prefixIndex: number, bodyStart: number, bodyEnd: number, isOutput: boolean, isExecution: boolean}}
 */
function describeTag(inner, isTriple) {
    let contentStart = inner[0] === "-" || inner[0] === "_" ? 1 : 0;
    const bodyEnd = inner.at(-1) === "-" || inner.at(-1) === "_" ? inner.length - 1 : inner.length;

    while (contentStart < bodyEnd && /\s/u.test(inner[contentStart])) {
        ++contentStart;
    }

    const candidatePrefix = TAG_PREFIXES.has(inner[contentStart]) ? inner[contentStart] : "";
    const contentWithoutControls = inner.slice(
        inner[0] === "-" || inner[0] === "_" ? 1 : 0,
        bodyEnd,
    );
    const prefix =
        candidatePrefix === "/" && !BLOCK_CLOSE_PATTERN.test(contentWithoutControls)
            ? ""
            : candidatePrefix;
    const prefixIndex = prefix ? contentStart : -1;
    let bodyStart = prefix ? contentStart + 1 : contentStart;
    while (bodyStart < bodyEnd && /\s/u.test(inner[bodyStart])) {
        ++bodyStart;
    }

    return {
        prefix,
        prefixIndex,
        bodyStart,
        bodyEnd,
        isOutput: isTriple || prefix === "" || prefix === "*",
        isExecution: prefix === "!",
    };
}

/**
 * Describe how a tag changes the open-helper stack.
 *
 * @param {string} inner - Text between the tag delimiters
 * @param {boolean} isTriple - Whether the tag used triple braces
 * @param {boolean} [asyncMode=false] - Whether async helper modifiers are active
 * @returns {{open: (string|undefined), close: (string|undefined)}} Stack change
 */
export function getTagNesting(inner, isTriple, asyncMode = false) {
    const description = describeTag(inner, isTriple);
    const body = inner.slice(description.bodyStart, description.bodyEnd).trim();

    if (description.prefix === "@" && !/\/\s*$/u.test(body)) {
        const helperBody = asyncMode ? body.replace(/^async +/u, "") : body;
        const match = /^([A-Za-z_$][\w$.-]*)/u.exec(helperBody);
        return match ? { open: match[1] } : {};
    }
    if (description.prefix === "/") {
        const match = /^([A-Za-z_$][\w$.-]*)/u.exec(body);
        return match ? { close: match[1] } : {};
    }
    return {};
}

/**
 * Scan all complete Squirrelly tags in a template.
 *
 * @param {string} source - Complete template source
 * @returns {{tags: Array<object>, unclosedIndex: (number|undefined), ambiguousIndex: (number|undefined)}}
 */
export function scanTemplateTags(source) {
    const tags = [];
    let cursor = 0;

    while (cursor < source.length) {
        const start = source.indexOf("{{", cursor);
        if (start === -1) {
            break;
        }

        const isTriple = source[start + 2] === "{";
        const openDelimiter = isTriple ? "{{{" : "{{";
        const closeDelimiter = isTriple ? "}}}" : "}}";
        const innerStart = start + openDelimiter.length;
        const closeIndex = findCloseDelimiter(source, innerStart, closeDelimiter);

        if (closeIndex === AMBIGUOUS_CLOSE_DELIMITER) {
            return { tags, ambiguousIndex: start };
        }
        if (closeIndex === -1) {
            return { tags, unclosedIndex: start };
        }

        const inner = source.slice(innerStart, closeIndex);
        tags.push({
            start,
            end: closeIndex + closeDelimiter.length,
            innerStart,
            closeIndex,
            inner,
            isTriple,
            ...describeTag(inner, isTriple),
        });
        cursor = closeIndex + closeDelimiter.length;
    }

    return { tags };
}

/**
 * Validate a filter's optional parenthesized argument list using the same
 * parenthesis-oriented view Squirrelly applies while parsing filters.
 *
 * @param {string} remainder - Text after the filter name
 * @returns {boolean} Whether it is empty or one complete argument list
 */
function hasValidFilterArguments(remainder) {
    const trimmed = remainder.trim();
    if (trimmed.length === 0) {
        return true;
    }
    if (trimmed[0] !== "(") {
        return false;
    }

    const masked = maskStringsAndComments(trimmed);
    let depth = 0;
    for (let index = 0; index < masked.length; ++index) {
        if (masked[index] === "(") {
            ++depth;
        } else if (masked[index] === ")") {
            --depth;
            if (depth < 0) {
                return false;
            }
            if (depth === 0 && masked.slice(index + 1).trim().length > 0) {
                return false;
            }
        }
    }

    return depth === 0;
}

/**
 * Split an output body into its JavaScript expression and top-level filters.
 *
 * @param {string} body - Tag body after any prefix
 * @returns {{expression: string, expressionEnd: number, filters: Array<{name: string, index: number, async: boolean}>, invalidFilters: Array<{index: number, text: string}>}}
 */
function splitExpressionAndFilters(body) {
    const operators = findFilterDepthOperators(body, ["||=", "|=", "||", "|"]);
    const leadingWhitespace = /^\s*/u.exec(body)?.[0].length ?? 0;
    const leadingRegexEnd =
        body[leadingWhitespace] === "/"
            ? skipRegexLiteral(body, leadingWhitespace)
            : leadingWhitespace;
    const protectedRegexEnd = leadingRegexEnd > leadingWhitespace + 1 ? leadingRegexEnd : 0;
    const filterPipes = operators.filter(
        ({ index, operator }) => operator === "|" && index >= protectedRegexEnd,
    );
    const expressionEnd = filterPipes[0]?.index ?? body.length;
    const filters = [];
    const invalidFilters = [];

    for (let index = 0; index < filterPipes.length; ++index) {
        const pipe = filterPipes[index];
        const segmentEnd = filterPipes[index + 1]?.index ?? body.length;
        const segment = body.slice(pipe.index + 1, segmentEnd);
        const leadingWhitespace = /^\s*/u.exec(segment)?.[0].length ?? 0;
        let segmentCursor = leadingWhitespace;
        const asyncMatch = /^async +/u.exec(segment.slice(segmentCursor));
        if (asyncMatch) {
            segmentCursor += asyncMatch[0].length;
        }
        const nameMatch = /^([A-Za-z_$][\w$.-]*)/u.exec(segment.slice(segmentCursor));
        const name = nameMatch?.[1];
        const remainder = name
            ? segment.slice(segmentCursor + name.length)
            : segment.slice(segmentCursor);

        if (name && hasValidFilterArguments(remainder)) {
            filters.push({
                name,
                index: pipe.index + 1 + segmentCursor,
                async: Boolean(asyncMatch),
            });
        } else {
            invalidFilters.push({
                index: pipe.index,
                text: segment.trim(),
            });
        }
    }

    return {
        expression: body.slice(0, expressionEnd),
        expressionEnd,
        filters,
        invalidFilters,
    };
}

/**
 * Wrap a JavaScript expression while retaining its surrounding whitespace.
 *
 * @param {string} expression - Expression text
 * @returns {string} Parenthesised expression
 */
function wrapExpression(expression) {
    const leading = /^\s*/u.exec(expression)?.[0] ?? "";
    const trailing = /\s*$/u.exec(expression)?.[0] ?? "";
    const core = expression.slice(leading.length, expression.length - trailing.length);
    return `${leading}(${core})${trailing}`;
}

/**
 * Parse one JavaScript expression while retaining parentheses and operator
 * token locations needed for source-level fixes.
 *
 * @param {string} expression - Expression text
 * @param {boolean} asyncMode - Whether top-level await is allowed
 * @returns {{ast: object, tokens: object[]} | undefined} Parsed syntax or undefined when invalid
 */
function parseJavaScriptExpression(expression, asyncMode) {
    const tokens = [];

    try {
        const ast = parseExpressionAt(expression, 0, {
            ecmaVersion: "latest",
            allowAwaitOutsideFunction: asyncMode,
            preserveParens: true,
            onToken: tokens,
        });
        const remainder = tokenizer(expression.slice(ast.end), {
            ecmaVersion: "latest",
        }).getToken();
        if (remainder.type.label !== "eof") {
            return undefined;
        }
        return { ast, tokens };
    } catch {
        return undefined;
    }
}

/**
 * @callback SyntaxNodeVisitor
 * @param {object} node - Acorn syntax node
 * @returns {void}
 */

/**
 * Visit Acorn syntax nodes without depending on a second tree-walker package.
 *
 * @param {unknown} value - Possible syntax node
 * @param {SyntaxNodeVisitor} visitor - Node visitor
 * @returns {void}
 */
function visitSyntaxNodes(value, visitor) {
    if (!value || typeof value !== "object" || typeof value.type !== "string") {
        return;
    }

    visitor(value);
    for (const child of Object.values(value)) {
        if (Array.isArray(child)) {
            for (const item of child) {
                visitSyntaxNodes(item, visitor);
            }
        } else {
            visitSyntaxNodes(child, visitor);
        }
    }
}

/**
 * Apply non-overlapping source edits from right to left.
 *
 * @param {string} source - Original source
 * @param {Array<{start: number, end: number, text: string}>} edits - Replacement and insertion edits
 * @returns {string} Edited source
 */
function applySourceEdits(source, edits) {
    let result = source;
    const ordered = [...edits].sort(
        (left, right) => right.start - left.start || right.end - left.end,
    );

    for (const edit of ordered) {
        result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    }
    return result;
}

/**
 * Rewrite the exposed logical-OR operators in an output expression to nullish
 * coalescing. Acorn distinguishes real operators from regex/comment text and
 * identifies `&&` operands that require parentheses when mixed with `??`.
 *
 * @param {string} expression - Output expression visible to Squirrelly's filter parser
 * @param {Array<{index: number, operator: string}>} exposedOperators - Filter-depth OR operators
 * @param {boolean} asyncMode - Whether top-level await is allowed
 * @returns {string | undefined} Rewritten expression, or undefined when a safe rewrite is ambiguous
 */
function rewriteLogicalOrAsNullish(expression, exposedOperators, asyncMode) {
    if (
        exposedOperators.length === 0 ||
        exposedOperators.some(({ operator }) => operator !== "||")
    ) {
        return undefined;
    }

    const parsed = parseJavaScriptExpression(expression, asyncMode);
    if (!parsed) {
        return undefined;
    }

    const exposedIndexes = new Set(exposedOperators.map(({ index }) => index));
    const logicalOrTokens = new Map(
        parsed.tokens
            .filter((token) => token.type.label === "||" && exposedIndexes.has(token.start))
            .map((token) => [token.start, token]),
    );
    const nodesByOperator = new Map();

    visitSyntaxNodes(parsed.ast, (node) => {
        if (node.type !== "LogicalExpression" || node.operator !== "||") {
            return;
        }

        const token = parsed.tokens.find(
            (candidate) =>
                candidate.type.label === "||" &&
                candidate.start >= node.left.end &&
                candidate.end <= node.right.start &&
                exposedIndexes.has(candidate.start),
        );
        if (token) {
            nodesByOperator.set(token.start, node);
        }
    });

    if (
        logicalOrTokens.size !== exposedOperators.length ||
        nodesByOperator.size !== exposedOperators.length ||
        exposedOperators.some(
            ({ index }) => !logicalOrTokens.has(index) || !nodesByOperator.has(index),
        )
    ) {
        return undefined;
    }

    const edits = exposedOperators.map(({ index }) => ({
        start: index,
        end: index + 2,
        text: "??",
    }));
    const parenthesizedRanges = new Set();

    for (const node of nodesByOperator.values()) {
        for (const operand of [node.left, node.right]) {
            if (operand.type !== "LogicalExpression" || operand.operator !== "&&") {
                continue;
            }

            const rangeKey = `${operand.start}:${operand.end}`;
            if (parenthesizedRanges.has(rangeKey)) {
                continue;
            }
            parenthesizedRanges.add(rangeKey);
            edits.push({ start: operand.start, end: operand.start, text: "(" });
            edits.push({ start: operand.end, end: operand.end, text: ")" });
        }
    }

    const rewritten = applySourceEdits(expression, edits);
    return parseJavaScriptExpression(rewritten, asyncMode) ? rewritten : undefined;
}

/**
 * Apply the small set of semantics-preserving source fixes to one tag.
 *
 * @param {object} tagFix - Tag fix inputs.
 * @param {string} tagFix.source - Complete original template source
 * @param {string} tagFix.inner - Original tag body
 * @param {number} tagFix.innerStart - Absolute start of the tag body
 * @param {boolean} tagFix.isTriple - Whether the tag used triple braces
 * @param {object} tagFix.options - Normalized lint options
 * @param {object} [tagFix.context] - Surrounding template context
 * @param {string} [tagFix.context.parentHelper] - Innermost open helper name
 * @returns {{inner: string, diagnostics: object[]}}
 */
export function fixTagSafety({ source, inner, innerStart, isTriple, options, context = {} }) {
    const diagnostics = [];
    let result = inner;
    let description = describeTag(result, isTriple);
    const controlStart = result[0] === "-" || result[0] === "_" ? 1 : 0;
    const leadingWhitespace =
        /^\s*/u.exec(result.slice(controlStart, description.bodyEnd))?.[0] ?? "";

    if (leadingWhitespace && result[controlStart + leadingWhitespace.length] === "!") {
        diagnostics.push(
            diagnostic(
                source,
                innerStart + controlStart + leadingWhitespace.length,
                "no-ambiguous-leading-prefix",
                "Whitespace before `!` still creates a Squirrelly execution tag. Use `{{! ... }}` for execution or parenthesize `(!expression)` for boolean output.",
            ),
        );
    }

    if (description.prefix === "#") {
        const rawBody = result.slice(description.bodyStart, description.bodyEnd);
        const asyncPrefix = options.async ? (/^async +/u.exec(rawBody)?.[0] ?? "") : "";
        const body = rawBody.slice(asyncPrefix.length);
        const invalidBranch = /^(else\s+if|elseif|elf)(?=\s*(?:\(|$))/u.exec(body);
        if (
            invalidBranch &&
            (context.parentHelper === "if" || context.parentHelper === undefined)
        ) {
            const normalizedSpelling = invalidBranch[1].replace(/\s+/gu, " ");
            const fixable =
                context.parentHelper === "if" &&
                /^(?:else[ \t]+if|elseif|elf)$/u.test(invalidBranch[1]) &&
                /^[ \t]*\(/u.test(body.slice(invalidBranch[0].length));
            diagnostics.push(
                diagnostic(
                    source,
                    innerStart + description.bodyStart + asyncPrefix.length,
                    "valid-elif",
                    `Squirrelly only recognizes \`elif(...)\`; \`${normalizedSpelling}\` silently skips the branch.`,
                    fixable,
                ),
            );
            if (fixable) {
                result =
                    result.slice(0, description.bodyStart) +
                    asyncPrefix +
                    body.replace(/^(?:else[ \t]+if|elseif|elf)(?=[ \t]*\()/u, "elif") +
                    result.slice(description.bodyEnd);
                description = describeTag(result, isTriple);
            }
        }
    }

    if (description.isOutput) {
        let body = result.slice(description.bodyStart, description.bodyEnd);
        let { expressionEnd } = splitExpressionAndFilters(body);
        let expression = body.slice(0, expressionEnd);
        const expressionWhitespace = /^\s*/u.exec(expression)?.[0].length ?? 0;
        const regexStart = expressionWhitespace;
        const regexEnd =
            expression[regexStart] === "/" ? skipRegexLiteral(expression, regexStart) : regexStart;

        if (!isTriple && description.prefix === "" && regexEnd > regexStart + 1) {
            const regexContainsCloseDelimiter = expression
                .slice(regexStart, regexEnd)
                .includes("}}");
            diagnostics.push(
                diagnostic(
                    source,
                    innerStart + description.bodyStart + regexStart,
                    "no-ambiguous-leading-prefix",
                    regexContainsCloseDelimiter
                        ? "A regex literal containing `}}` closes the Squirrelly tag before JavaScript can parse it. Escape the braces or use a `RegExp` constructor."
                        : "A leading regex literal is parsed as a Squirrelly block close. Parenthesize the expression.",
                    !regexContainsCloseDelimiter,
                ),
            );
            if (!regexContainsCloseDelimiter) {
                result =
                    result.slice(0, description.bodyStart) +
                    wrapExpression(expression) +
                    body.slice(expressionEnd) +
                    result.slice(description.bodyEnd);
                description = describeTag(result, isTriple);
                body = result.slice(description.bodyStart, description.bodyEnd);
                ({ expressionEnd } = splitExpressionAndFilters(body));
                expression = body.slice(0, expressionEnd);
            }
        }

        const logicalOrOperators = findFilterDepthOperators(expression, ["||=", "||"]);
        const logicalOr = logicalOrOperators[0];

        if (logicalOr) {
            const nullishExpression =
                options.logicalOrFix === "nullish"
                    ? rewriteLogicalOrAsNullish(expression, logicalOrOperators, options.async)
                    : undefined;
            const usesNullishFix = nullishExpression !== undefined;
            diagnostics.push(
                diagnostic(
                    source,
                    innerStart + description.bodyStart + logicalOr.index,
                    "no-unparenthesized-logical-or",
                    usesNullishFix
                        ? "A top-level `||` is parsed as a Squirrelly filter separator. The configured fix rewrites it to `??`, so only nullish values use the fallback."
                        : options.logicalOrFix === "nullish"
                          ? "A top-level `||`-like token is parsed as a Squirrelly filter separator. It could not be safely rewritten to `??`, so the expression was parenthesized."
                          : "A top-level `||` is parsed as a Squirrelly filter separator. Parenthesize the expression or use `??` when nullish fallback semantics are intended.",
                    true,
                ),
            );
            result =
                result.slice(0, description.bodyStart) +
                (nullishExpression ?? wrapExpression(expression)) +
                body.slice(expressionEnd) +
                result.slice(description.bodyEnd);
            description = describeTag(result, isTriple);
        }

        if (options.noImplicitNullOutput) {
            const updatedBody = result.slice(description.bodyStart, description.bodyEnd);
            const split = splitExpressionAndFilters(updatedBody);
            const expressionText = split.expression.trim();
            const maskedExpressionText = maskStringsAndComments(expressionText, true);
            const optionalMember =
                /^[A-Za-z_$][\w$]*(?:(?:\.|\?\.)[A-Za-z_$][\w$]*|\?\.\[[^\]\r\n]+\]|\[[^\]\r\n]+\])+$/u;
            const filtersDoNotSupplyFallback = split.filters.every(
                (filter) => filter.name === "e" || (filter.name === "safe" && !filter.async),
            );
            if (
                split.invalidFilters.length === 0 &&
                filtersDoNotSupplyFallback &&
                maskedExpressionText.includes("?.") &&
                optionalMember.test(expressionText)
            ) {
                const expressionOffset = updatedBody.indexOf(expressionText);
                diagnostics.push(
                    diagnostic(
                        source,
                        innerStart + description.bodyStart + expressionOffset,
                        "no-implicit-null-output",
                        "Optional-chain output can render `undefined`; add an explicit fallback.",
                        true,
                    ),
                );
                // The replacer must be a function: passing the expression as a
                // replacement string interprets `$&`, `$'`, and backtick-adjacent
                // patterns inside it and silently corrupts the template.
                const replacement = split.expression.replace(
                    expressionText,
                    () => `${expressionText} ?? ""`,
                );
                result =
                    result.slice(0, description.bodyStart) +
                    replacement +
                    updatedBody.slice(split.expressionEnd) +
                    result.slice(description.bodyEnd);
            }
        }
    }

    return { inner: result, diagnostics };
}

/**
 * Test whether an expression begins with an assignment or update operation.
 *
 * @param {string} expression - Output expression
 * @returns {boolean} Whether it mutates and returns a value
 */
function isOutputMutation(expression) {
    let candidate = expression.trim();

    // Remove only parentheses that enclose the complete expression. This
    // exposes root assignments such as `({ value } = source)` without
    // promoting mutations nested inside calls or callback bodies.
    while (candidate.startsWith("(") && candidate.endsWith(")")) {
        const maskedCandidate = maskStringsAndComments(candidate, true);
        let depth = 0;
        let enclosesWholeExpression = true;
        for (let index = 0; index < maskedCandidate.length; ++index) {
            if (maskedCandidate[index] === "(") {
                ++depth;
            } else if (maskedCandidate[index] === ")") {
                --depth;
                if (depth === 0 && maskedCandidate.slice(index + 1).trim().length > 0) {
                    enclosesWholeExpression = false;
                    break;
                }
            }
        }
        if (!enclosesWholeExpression || depth !== 0) {
            break;
        }
        candidate = candidate.slice(1, -1).trim();
    }

    const masked = maskStringsAndComments(candidate, true);
    const assignmentOperators = [
        "??=",
        "||=",
        "&&=",
        "**=",
        ">>>=",
        "<<=",
        ">>=",
        "+=",
        "-=",
        "*=",
        "/=",
        "%=",
        "&=",
        "|=",
        "^=",
    ];
    let parenthesisDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;

    for (let index = 0; index < masked.length; ++index) {
        const character = masked[index];
        if (character === "(") {
            ++parenthesisDepth;
        } else if (character === ")") {
            parenthesisDepth = Math.max(0, parenthesisDepth - 1);
        } else if (character === "[") {
            ++bracketDepth;
        } else if (character === "]") {
            bracketDepth = Math.max(0, bracketDepth - 1);
        } else if (character === "{") {
            ++braceDepth;
        } else if (character === "}") {
            braceDepth = Math.max(0, braceDepth - 1);
        } else if (parenthesisDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
            // A concise arrow body is deferred code. Mutations after the
            // arrow are not evaluated while rendering the function value.
            if (masked.startsWith("=>", index)) {
                return false;
            }
            if (masked.startsWith("++", index) || masked.startsWith("--", index)) {
                return true;
            }
            if (assignmentOperators.some((operator) => masked.startsWith(operator, index))) {
                return true;
            }
            if (
                character === "=" &&
                masked[index + 1] !== "=" &&
                masked[index + 1] !== ">" &&
                !"=!<>".includes(masked[index - 1] ?? "")
            ) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Mask string and comment contents before a conservative token search.
 *
 * @param {string} source - JavaScript-like source
 * @param {boolean} [maskRegex=false] - Whether JavaScript regex literals should also be masked
 * @returns {string} Equal-length masked text
 */
function maskStringsAndComments(source, maskRegex = false) {
    const output = source.split("");

    function mask(index) {
        if (source[index] !== "\n" && source[index] !== "\r") {
            output[index] = " ";
        }
    }

    function maskQuoted(start, quote) {
        let cursor = start;
        mask(cursor);
        ++cursor;
        while (cursor < source.length) {
            const character = source[cursor];
            mask(cursor);
            if (character === "\\") {
                ++cursor;
                if (cursor < source.length) {
                    mask(cursor);
                }
            } else if (character === quote) {
                return cursor + 1;
            }
            ++cursor;
        }
        return cursor;
    }

    function maskComment(start, closeToken) {
        const end = source.indexOf(closeToken, start + 2);
        const limit = end === -1 ? source.length : end + closeToken.length;
        for (let cursor = start; cursor < limit; ++cursor) {
            mask(cursor);
        }
        return limit;
    }

    function maskTemplate(start) {
        let cursor = start;
        mask(cursor);
        ++cursor;
        while (cursor < source.length) {
            const character = source[cursor];
            if (character === "\\") {
                mask(cursor);
                ++cursor;
                if (cursor < source.length) {
                    mask(cursor);
                    ++cursor;
                }
            } else if (character === "`") {
                mask(cursor);
                return cursor + 1;
            } else if (character === "$" && source[cursor + 1] === "{") {
                mask(cursor);
                cursor = scanCode(cursor + 2, true);
            } else {
                mask(cursor);
                ++cursor;
            }
        }
        return cursor;
    }

    function scanCode(start, stopAtClosingBrace = false) {
        let cursor = start;
        let braceDepth = stopAtClosingBrace ? 1 : 0;

        while (cursor < source.length) {
            const character = source[cursor];
            if (character === '"' || character === "'") {
                cursor = maskQuoted(cursor, character);
            } else if (character === "`") {
                cursor = maskTemplate(cursor);
            } else if (source.startsWith("/*", cursor)) {
                cursor = maskComment(cursor, "*/");
            } else if (source.startsWith("//", cursor)) {
                const newline = source.indexOf("\n", cursor + 2);
                const limit = newline === -1 ? source.length : newline;
                for (; cursor < limit; ++cursor) {
                    mask(cursor);
                }
            } else if (maskRegex && character === "/" && canStartRegex(source, start, cursor)) {
                const regexEnd = skipRegexLiteral(source, cursor);
                if (regexEnd > cursor + 1) {
                    for (; cursor < regexEnd; ++cursor) {
                        mask(cursor);
                    }
                } else {
                    ++cursor;
                }
            } else if (stopAtClosingBrace && character === "{") {
                ++braceDepth;
                ++cursor;
            } else if (stopAtClosingBrace && character === "}") {
                --braceDepth;
                ++cursor;
                if (braceDepth === 0) {
                    return cursor;
                }
            } else {
                ++cursor;
            }
        }
        return cursor;
    }

    scanCode(0);

    return output.join("");
}

/**
 * Compute a small Levenshtein distance for filter-name suggestions.
 *
 * @param {string} left - Misspelled value
 * @param {string} right - Candidate value
 * @returns {number} Edit distance
 */
function editDistance(left, right) {
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

    for (let leftIndex = 1; leftIndex <= left.length; ++leftIndex) {
        const current = [leftIndex];
        for (let rightIndex = 1; rightIndex <= right.length; ++rightIndex) {
            current[rightIndex] = Math.min(
                current[rightIndex - 1] + 1,
                previous[rightIndex] + 1,
                previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
            );
        }
        previous = current;
    }

    return previous[right.length];
}

/**
 * Suggest a configured filter only when the candidate is reasonably close.
 *
 * @param {string} unknown - Unknown filter name
 * @param {string[]} candidates - Known filter names
 * @returns {string | undefined} Suggested name
 */
function suggestFilter(unknown, candidates) {
    const normalizedUnknown = unknown.toLowerCase();
    const prefixCandidates = candidates.filter((candidate) => {
        const normalizedCandidate = candidate.toLowerCase();
        return (
            normalizedCandidate.startsWith(normalizedUnknown) ||
            normalizedUnknown.startsWith(normalizedCandidate)
        );
    });
    const candidatesToRank = prefixCandidates.length > 0 ? prefixCandidates : candidates;
    let best;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidatesToRank) {
        const distance = editDistance(normalizedUnknown, candidate.toLowerCase());
        if (distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
        }
    }

    if (!best) {
        return undefined;
    }
    return bestDistance <= Math.max(2, Math.floor(unknown.length * 0.4)) ||
        prefixCandidates.length > 0
        ? best
        : undefined;
}

/**
 * Reduce an engine error to one actionable line without embedding generated JS.
 *
 * @param {unknown} error - Squirrelly compile error
 * @returns {string} Concise error text
 */
function compileErrorMessage(error) {
    const raw = error instanceof Error ? error.message : String(error);
    const lines = raw
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(
            (line) =>
                line && !/^=+$/u.test(line) && !/^\^$/u.test(line) && !line.startsWith("var tR="),
        );
    return lines.length > 1 && lines[0] === "Bad template syntax"
        ? `${lines[0]}: ${lines[1]}`
        : lines[0] || raw;
}

/**
 * Convert a one-based line and column into an absolute source index.
 *
 * @param {string} source - Complete template source
 * @param {number} line - One-based line
 * @param {number} column - One-based column
 * @returns {number} Zero-based source index
 */
function indexFromLocation(source, line, column) {
    let index = 0;
    for (let currentLine = 1; currentLine < line; ++currentLine) {
        const newline = source.indexOf("\n", index);
        if (newline === -1) {
            return 0;
        }
        index = newline + 1;
    }
    return Math.min(source.length, index + Math.max(0, column - 1));
}

/**
 * Analyze the original template for non-fixable safety problems.
 *
 * Locations in the returned diagnostics always refer to this input source.
 * Engine compilation is handled separately after safe fixes are known.
 *
 * @param {object} analysis - Safety analysis inputs
 * @param {string} analysis.source - Original template source
 * @param {object} analysis.options - Normalized lint options
 * @param {object} [analysis.scanResult] - Previously scanned template tags
 * @returns {object[]} Diagnostics
 */
export function analyzeTemplateSafety({ source, options, scanResult = scanTemplateTags(source) }) {
    const diagnostics = [];
    const { tags, unclosedIndex, ambiguousIndex } = scanResult;
    const knownFilters = options.knownFilters
        ? new Set([...BUILT_IN_FILTERS, ...options.knownFilters])
        : undefined;
    const unsafeFilters = new Set(options.unsafeRawFilters);
    const helperStack = [];

    if (unclosedIndex !== undefined) {
        diagnostics.push(
            diagnostic(
                source,
                unclosedIndex,
                "valid-squirrelly-syntax",
                "Unclosed Squirrelly tag; the rest of the file cannot be analyzed reliably.",
            ),
        );
    }

    // With engine compilation enabled, Squirrelly itself reports the
    // irreducibly ambiguous tag. Without it, this diagnostic keeps the
    // documented guarantee that ambiguous tags are reported, not silently
    // passed through unchanged.
    if (ambiguousIndex !== undefined && !options.compile) {
        diagnostics.push(
            diagnostic(
                source,
                ambiguousIndex,
                "valid-squirrelly-syntax",
                "Tag is ambiguous between a block close and a leading regex expression; it was left unchanged. Parenthesize the expression to disambiguate.",
            ),
        );
    }

    for (const tag of tags) {
        const body = source.slice(tag.innerStart + tag.bodyStart, tag.innerStart + tag.bodyEnd);
        const split = splitExpressionAndFilters(body);

        if (!tag.isOutput) {
            const logicalOr = findFilterDepthOperators(body, ["||"])[0];
            const isCommentText =
                tag.isExecution &&
                logicalOr &&
                !maskStringsAndComments(body).startsWith("||", logicalOr.index);
            if (logicalOr && !isCommentText) {
                diagnostics.push(
                    diagnostic(
                        source,
                        tag.innerStart + tag.bodyStart + logicalOr.index,
                        "no-unparenthesized-logical-or",
                        "A top-level `||` is parsed as a Squirrelly filter separator. Parenthesize the containing JavaScript expression.",
                    ),
                );
            }
        }

        if (tag.isOutput && (isOutputMutation(split.expression) || isOutputMutation(body))) {
            const expressionOffset = body.search(/\S/u);
            diagnostics.push(
                diagnostic(
                    source,
                    tag.innerStart + tag.bodyStart + Math.max(0, expressionOffset),
                    "no-output-assignment",
                    "Assignments and updates in output tags render their resulting value. Use an execution tag (`{{! ... }}`) for side effects.",
                ),
            );
        }

        for (const invalidFilter of split.invalidFilters) {
            const normalizedText = invalidFilter.text.replace(/\s+/gu, " ");
            const preview =
                normalizedText.length > 60 ? `${normalizedText.slice(0, 57)}...` : normalizedText;
            diagnostics.push(
                diagnostic(
                    source,
                    tag.innerStart + tag.bodyStart + invalidFilter.index,
                    "valid-filter",
                    `A filter separator must be followed by a valid filter call; found \`${preview || "empty filter"}\`.`,
                ),
            );
        }

        for (const filter of split.filters) {
            if (filter.async && !options.async) {
                diagnostics.push(
                    diagnostic(
                        source,
                        tag.innerStart + tag.bodyStart + filter.index,
                        "valid-async-syntax",
                        `Async filter \`${filter.name}\` requires the \`async\` lint option.`,
                    ),
                );
            }
        }

        if (options.forbidExecute && tag.isExecution) {
            diagnostics.push(
                diagnostic(
                    source,
                    tag.innerStart + tag.prefixIndex,
                    "no-execute-tag",
                    "Execution tags are forbidden by this project configuration.",
                ),
            );
        }

        const safeFilterIndex = split.filters.findIndex(
            ({ name, async }) => name === "safe" && !async,
        );
        if (options.forbidSafe && safeFilterIndex !== -1) {
            const filter = split.filters[safeFilterIndex];
            diagnostics.push(
                diagnostic(
                    source,
                    tag.innerStart + tag.bodyStart + filter.index,
                    "no-safe-filter",
                    "The `safe` filter is forbidden by this project configuration.",
                ),
            );
        }

        if (knownFilters) {
            for (const filter of split.filters) {
                const isRawSafeMarker = filter.name === "safe" && !filter.async;
                if (!isRawSafeMarker && !knownFilters.has(filter.name)) {
                    const suggestion = suggestFilter(filter.name, options.knownFilters);
                    diagnostics.push(
                        diagnostic(
                            source,
                            tag.innerStart + tag.bodyStart + filter.index,
                            "known-filter",
                            `Unknown Squirrelly filter \`${filter.name}\`.${suggestion ? ` Did you mean \`${suggestion}\`?` : ""}`,
                        ),
                    );
                }
            }
        }

        const isRawOutput = tag.isTriple || tag.prefix === "*" || safeFilterIndex !== -1;
        if (tag.isOutput && isRawOutput) {
            const unsafeFilter = split.filters.find(
                ({ name, async }) =>
                    name !== "safe" && unsafeFilters.has(name) && (!async || options.async),
            );
            const maskedExpression = maskStringsAndComments(split.expression, true);
            const rawJson = /\bJSON\s*\.\s*stringify\s*\(/u.test(maskedExpression);
            if (rawJson || unsafeFilter) {
                const unsafeName = rawJson
                    ? "JSON.stringify(...)"
                    : `the \`${unsafeFilter.name}\` filter`;
                diagnostics.push(
                    diagnostic(
                        source,
                        tag.innerStart + tag.bodyStart + (unsafeFilter?.index ?? 0),
                        "no-unsafe-raw-json",
                        `Rendering ${unsafeName} as raw output can permit a \`</script>\` breakout. Use a project-approved script-safe serializer.`,
                    ),
                );
            }
        }

        if (tag.prefix === "@") {
            const trimmedBody = body.trimStart();
            const hasAsyncModifier = /^async +/u.test(trimmedBody);
            if (hasAsyncModifier && !options.async) {
                diagnostics.push(
                    diagnostic(
                        source,
                        tag.innerStart + tag.bodyStart,
                        "valid-async-syntax",
                        "Async helpers require the `async` lint option.",
                    ),
                );
            }
            const helperBody = options.async ? trimmedBody.replace(/^async +/u, "") : trimmedBody;
            const helperMatch = /^([A-Za-z_$][\w$.-]*)/u.exec(helperBody);
            const selfClosing = /\/\s*$/u.test(body);
            if (helperMatch && !selfClosing) {
                helperStack.push({ name: helperMatch[1], seenElse: false });
            }
        } else if (tag.prefix === "/") {
            helperStack.pop();
        } else if (tag.prefix === "#") {
            const trimmedBody = body.trim();
            const hasAsyncModifier = /^async +/u.test(trimmedBody);
            if (hasAsyncModifier && !options.async) {
                diagnostics.push(
                    diagnostic(
                        source,
                        tag.innerStart + tag.bodyStart,
                        "valid-async-syntax",
                        "Async blocks require the `async` lint option.",
                    ),
                );
                continue;
            }
            const branchBody = options.async ? trimmedBody.replace(/^async +/u, "") : trimmedBody;
            const branchMatch = /^([^()]+?)(?:\s*\(([^]*)\))?$/u.exec(branchBody);
            if (branchMatch) {
                const branchName = branchMatch[1].trim();
                const currentHelper = helperStack.at(-1);
                const ruleIndex = tag.innerStart + tag.bodyStart;
                const invalidElifSpelling = /^(?:else\s+if|elseif|elf)$/u.test(branchName);

                if (!currentHelper) {
                    const message =
                        branchName === "else" || branchName === "elif"
                            ? `\`${branchName}\` must belong to an open \`if\` helper.`
                            : `Block \`${branchName}\` must belong to an open helper.`;
                    diagnostics.push(diagnostic(source, ruleIndex, "valid-native-branch", message));
                } else if (currentHelper.name !== "if") {
                    continue;
                } else if (invalidElifSpelling) {
                    // `valid-elif` owns this finding and, when safe, its fix.
                    continue;
                } else if (branchName !== "else" && branchName !== "elif") {
                    diagnostics.push(
                        diagnostic(
                            source,
                            ruleIndex,
                            "valid-native-branch",
                            `Unknown \`${branchName}\` block inside \`if\`; expected \`elif(...)\` or \`else\`.`,
                        ),
                    );
                } else if (branchName === "elif" && currentHelper.seenElse) {
                    diagnostics.push(
                        diagnostic(
                            source,
                            ruleIndex,
                            "valid-native-branch",
                            "`elif` cannot appear after `else`.",
                        ),
                    );
                } else if (branchName === "else" && currentHelper.seenElse) {
                    diagnostics.push(
                        diagnostic(
                            source,
                            ruleIndex,
                            "valid-native-branch",
                            "An `if` helper can contain only one `else` branch.",
                        ),
                    );
                }

                if (branchName === "elif" && !branchMatch[2]?.trim()) {
                    diagnostics.push(
                        diagnostic(
                            source,
                            ruleIndex,
                            "valid-native-branch",
                            "`elif` requires a condition.",
                        ),
                    );
                }
                if (branchName === "else" && branchMatch[2] !== undefined) {
                    diagnostics.push(
                        diagnostic(
                            source,
                            ruleIndex,
                            "valid-native-branch",
                            "`else` does not accept a condition.",
                        ),
                    );
                }
                if (branchName === "else") {
                    currentHelper.seenElse = true;
                }
            }
        }
    }

    return diagnostics;
}

/**
 * Compile a template and return its engine error without throwing.
 *
 * @param {string} source - Template source
 * @param {boolean} asyncMode - Whether Squirrelly should compile an async template
 * @returns {unknown | undefined} Compile error
 */
function getCompileError(source, asyncMode) {
    try {
        compileTemplate(source, asyncMode ? { async: true } : undefined);
        return undefined;
    } catch (error) {
        return error;
    }
}

/**
 * Validate the finalized template while keeping diagnostics anchored to the
 * original input. An error repaired by a safe fix is suppressed. If a fix
 * exposes a different engine error, it is reported at the start of the
 * original source rather than mixing coordinate spaces.
 *
 * @param {object} compilation - Compilation inputs.
 * @param {string} compilation.originalSource - Original template source
 * @param {string} compilation.finalizedSource - Formatted and safely fixed source
 * @param {boolean} compilation.enabled - Whether engine compilation is enabled
 * @param {boolean} compilation.asyncMode - Whether Squirrelly should compile an async template
 * @param {number} [compilation.unclosedIndex] - Start of an unclosed tag found by the shared scan
 * @returns {object[]} Zero or one compile diagnostic
 */
export function analyzeTemplateCompilation({
    originalSource,
    finalizedSource,
    enabled,
    asyncMode,
    unclosedIndex,
}) {
    if (!enabled) {
        return [];
    }

    const originalError = getCompileError(originalSource, asyncMode);
    const finalizedError =
        finalizedSource === originalSource
            ? originalError
            : getCompileError(finalizedSource, asyncMode);
    if (!finalizedError) {
        return [];
    }

    const finalizedMessage =
        finalizedError instanceof Error ? finalizedError.message : String(finalizedError);
    if (unclosedIndex !== undefined && /unclosed/iu.test(finalizedMessage)) {
        return [];
    }

    const originalMessage =
        originalError instanceof Error ? originalError.message : String(originalError ?? "");
    const sameFailure =
        originalError && compileErrorMessage(originalError) === compileErrorMessage(finalizedError);
    const match = sameFailure ? / at line (\d+) col (\d+):/u.exec(originalMessage) : undefined;
    const index = match ? indexFromLocation(originalSource, Number(match[1]), Number(match[2])) : 0;

    return [
        diagnostic(
            originalSource,
            index,
            "valid-squirrelly-syntax",
            `Squirrelly compile failed: ${compileErrorMessage(finalizedError)}`,
        ),
    ];
}
