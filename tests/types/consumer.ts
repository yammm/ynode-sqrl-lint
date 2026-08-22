import {
    DEFAULT_LINT_OPTIONS,
    lintContent,
    rules,
    type LintDiagnostic,
    type LintRule,
} from "@ynode/sqrl-lint";
import metadata from "@ynode/sqrl-lint/package.json" with { type: "json" };
import { languages, options, parsers, printers } from "@ynode/sqrl-lint/prettier";

const result = lintContent("Hello {{ it.name }}", {
    compile: false,
    logicalOrFix: "parenthesize",
});
const diagnostics: readonly LintDiagnostic[] = result.diagnostics;
const immutableRules: readonly LintRule[] = rules;
const firstRule = rules[0];

if (firstRule) {
    firstRule.pattern.test(" it.name ");
    // @ts-expect-error Public rules are immutable.
    firstRule.name = "changed";
}

// @ts-expect-error Public rules are immutable.
rules.push({ name: "unsafe", pattern: /.*/u, replacement: "" });

void [DEFAULT_LINT_OPTIONS, diagnostics, immutableRules, languages, options, parsers, printers];
metadata.name satisfies string;
