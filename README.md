# @ynode/sqrl-lint

Copyright (c) 2026 Michael Welter <me@mikinho.com>

[![npm version](https://img.shields.io/npm/v/@ynode/sqrl-lint.svg)](https://www.npmjs.com/package/@ynode/sqrl-lint) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A dedicated linter and formatter for Squirrelly (`.sqrl`) templates, built specifically for the `@ynode` Fastify ecosystem. It combines a tag-aware formatter with Squirrelly engine validation and targeted semantic rules based on real template failures. Surrounding HTML, CSS, and JavaScript remain untouched.

## Features

- **Strict Formatting:** Enforces consistent spacing for helpers (`{{@`, `{{#`), base brackets (`{{`, `}}`), raw outputs (`{{*`), whitespace controls, execution tags (`{{!`), and block closures (`{{/`).
- **Semantic Guardrails:** Catches bare logical OR expressions, dead `elseif` spellings, output assignments, unsafe JSON rendering, invalid native branches, malformed templates, and optional project policies.
- **Engine Validation:** Compiles each finalized template with Squirrelly so malformed JavaScript, comments, and helper structure fail during linting instead of at request time.
- **Actionable Diagnostics:** Emits stable rule IDs with one-based line and column locations in text, JSON, and SARIF 2.1.0 reports.
- **Read-Only Checks:** Fails CI pipelines with exit code `1` for formatting or semantic violations.
- **Quality of Life:** Automatically ignores `node_modules` by default and presents beautiful, colorized error logs and success reports.
- **Conservative Auto-Repair:** `--fix` applies formatting and semantics-preserving repairs while leaving judgment calls as diagnostics.
- **Fast-Glob Powered:** Built-in `fast-glob` processing natively supports arbitrary inclusion and exclusion targeting.

## Node.js support

This package requires Node.js 20.19.0 or newer. CI exercises the exact 20.19.0, 22.13.0, and 24.0.0 boundaries. Node.js 20 remains tested only to preserve the current major-version contract even though upstream support has ended; use Node.js 22 or 24 for supported production deployments. A newly released Node.js major is not considered supported until it is added to CI, even when the open `engines` range admits it.

## Installation

```bash
npm install -D @ynode/sqrl-lint
```

Supported runtimes are Node.js 20 at 20.19 or newer, Node.js 22 at 22.12 or newer, or Node.js 23+, matching the CLI's yargs runtime dependency.

## Usage

You can use the linter either manually via `npx` or wire it directly into your `package.json` scripts block.

### Check Formatting (Read-Only)

```bash
npx sqrl-lint "src/**/*.sqrl"
```

If any files need formatting or contain semantic errors, diagnostics are logged to `stderr` and the process exits with a non-zero code (see [Exit Codes](#exit-codes)).

### Auto-Fix Formatting

```bash
npx sqrl-lint "src/**/*.sqrl" --fix
```

Applies formatting plus safe semantic repairs. Non-fixable findings, such as an assignment in an output tag, remain diagnostics and still produce exit code `1` after fix mode.

### JSON Reporting

```bash
npx sqrl-lint "src/**/*.sqrl" --report json
```

In file mode, this emits a machine-readable JSON summary to `stdout`, suitable for CI/log parsers. In `--stdin` mode, formatted template content uses `stdout`, so the JSON report is written to `stderr` instead. Both modes use the same summary schema: mode and success, aggregate file/error counts, concurrency and duration, plus a `results` array with per-file statuses and diagnostics. Each diagnostic includes `ruleId`, `severity`, `message`, `index`, `line`, `column`, and `fixable`. Check-mode locations refer to the invocation's original input. After `--fix` writes safe repairs, unresolved diagnostics are recalculated against the finalized file or stdout content.

### SARIF Reporting

```bash
npx sqrl-lint "src/**/*.sqrl" --report sarif > sqrl-lint.sarif
```

SARIF 2.1.0 output integrates with code-scanning systems while keeping rule IDs and source locations stable. Semantic diagnostics retain their normal IDs, and formatting differences use the dedicated `formatting` rule at the first changed source position. Successful `--fix` runs omit resolved findings. Project files use portable `%SRCROOT%`-relative artifact URIs, and operational failures appear as invocation notifications.

As with JSON reporting, file-mode SARIF is written to `stdout`; stdin template data stays on `stdout`, so `--stdin --report sarif` writes the report to `stderr`.

### Disable ANSI Colors

```bash
npx sqrl-lint "src/**/*.sqrl" --no-color
```

Disables ANSI color styling in text output.

### Diffs (Check Mode)

```bash
npx sqrl-lint "src/**/*.sqrl" --diff
```

Unified diffs are enabled by default for each file that needs formatting, making CI failures actionable. Use `--no-diff` to suppress them.

### Ignore Additional Files

```bash
npx sqrl-lint "src/**/*.sqrl" --ignore "src/vendor/**" --ignore "**/*.generated.sqrl"
```

Adds one or more glob patterns to the built-in ignores. If no input files match after ignores are applied, the command reports an operational error and exits with code `2`.

### Parallel Processing

```bash
npx sqrl-lint "src/**/*.sqrl" --fix --concurrency 4
```

Processes files with bounded parallelism for faster runs on large repositories.

### Stdin / Editor Integration

```bash
cat src/views/home.sqrl | npx sqrl-lint --stdin --fix
```

Reads template content from stdin and writes the formatted output to stdout, making it ideal for editor "format on save" integrations, shell pipelines, and git hooks. Anonymous stdin uses the base lint configuration. Use `--stdin-filepath <path>` to control the filename shown in error messages and diffs and opt that virtual path into matching configuration overrides.

### Quiet Mode

```bash
npx sqrl-lint "src/**/*.sqrl" --quiet
```

Suppresses reports and diagnostics, including JSON and SARIF reports; only the exit code indicates the result. In `--stdin` mode, the formatted template content remains on `stdout` because it is the command's data output.

### Version

```bash
npx sqrl-lint --version
```

Prints the installed package version and exits.

## Exit Codes

| Code | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| `0`  | All files are formatted and no semantic lint errors remain            |
| `1`  | One or more files need formatting or have semantic lint errors        |
| `2`  | Operational error (I/O failure, invalid arguments, permission denied) |

## Formatting Rules

The linter enforces consistent spacing inside Squirrelly tag boundaries. Rules are applied in order; the first match wins.

| Tag Type            | Before                | After                   |
| ------------------- | --------------------- | ----------------------- |
| Helper / Macro open | `{{@extends()}}`      | `{{@ extends() }}`      |
| Native branch       | `{{#elif(user)}}`     | `{{# elif(user) }}`     |
| Self-closing helper | `{{@partial("x")/}}`  | `{{@ partial("x") /}}`  |
| Execution           | `{{!it.ready=true;}}` | `{{! it.ready=true; }}` |
| Block close         | `{{/if}}`             | `{{/ if }}`             |
| Expression          | `{{name}}`            | `{{ name }}`            |
| Raw output          | `{{*rawHtml}}`        | `{{* rawHtml }}`        |
| Whitespace controls | `{{-name-}}`          | `{{- name -}}`          |

Content outside `{{ ... }}` boundaries (HTML, CSS, JS) is never modified.

## Semantic Rules

The default rules favor low-noise failures and semantics-preserving fixes.

| Rule ID | Behavior | Purpose |
| --- | --- | --- |
| `no-unparenthesized-logical-or` | Fix | Protects top-level `\|\|` with parentheses or the configured nullish rewrite |
| `valid-elif` | Fix | Rewrites `else if(...)`, `elseif(...)`, and `elf(...)` to Squirrelly's recognized `elif(...)` |
| `valid-squirrelly-syntax` | Report | Reports unclosed tags and failures from `Squirrelly.compile()` |
| `valid-native-branch` | Report | Rejects orphaned, duplicate, missing-condition, or out-of-order native branches |
| `valid-filter` | Report | Rejects empty or malformed filter segments |
| `valid-async-syntax` | Report | Requires async compilation when a helper, block, or filter uses the `async` modifier |
| `no-ambiguous-leading-prefix` | Mixed | Disambiguates leading regex output and rejects whitespace-obscured execution prefixes |
| `no-output-assignment` | Report | Prevents assignment results from leaking into rendered HTML |
| `no-unsafe-raw-json` | Report | Rejects raw `JSON.stringify(...)` and configured unsafe serializer output |
| `known-filter` | Opt-in | Reports filter names absent from the project's configured registry |
| `no-implicit-null-output` | Opt-in | Adds `?? ""` to a bare optional-chain output expression |
| `no-execute-tag` / `no-safe-filter` | Opt-in | Restricts execution or `safe` filters on sensitive template surfaces |

For example, this is not valid JavaScript from Squirrelly's parser's point of view:

```sqrl
{{ it.name || "Unknown" }}
```

Squirrelly sees each top-level `|` as a filter separator. The safe automatic repair preserves the author's JavaScript semantics:

```sqrl
{{ (it.name || "Unknown") }}
```

That semantics-preserving repair is the default. Projects that intentionally want nullish fallback semantics can set `logicalOrFix` to `"nullish"`:

```sqrl
{{ it.name ?? "Unknown" }}
```

Nullish mode rewrites each exposed JavaScript logical-OR operator, while distinguishing it from regex text, comments, and `||=`. It also adds the parentheses JavaScript requires when `??` is combined with `&&`. Already-parenthesized logical OR remains untouched because it is valid, intentional JavaScript. Opting in changes behavior for `""`, `0`, and `false`: those values no longer use the fallback.

Assignments are reported without an automatic rewrite because rendering the assigned value could theoretically be intentional:

```sqrl
{{ it.page = "dashboard" }}
```

For a side effect that should not render, use Squirrelly's JavaScript execution prefix:

```sqrl
{{! it.page = "dashboard"; }}
```

## Prettier Integration

The package ships a Prettier plugin so you can format `.sqrl` files alongside the rest of your codebase. Install Prettier alongside this package:

```bash
npm install -D prettier @ynode/sqrl-lint
```

Then add the plugin to your Prettier configuration:

```json
{
    "plugins": ["@ynode/sqrl-lint/prettier"]
}
```

When the project uses nullish fixes, configure Prettier consistently so it does not apply the default parenthesizing repair before the CLI runs:

```json
{
    "plugins": ["@ynode/sqrl-lint/prettier"],
    "sqrlLogicalOrFix": "nullish"
}
```

Once configured, `prettier --write "**/*.sqrl"` applies the CLI's tag spacing and default safe repairs. Prettier does not report non-fixable diagnostics or load `.sqrl-lintrc.json`; keep the CLI in CI as the semantic enforcement gate.

## Programmatic API

```js
import { lintContent } from "@ynode/sqrl-lint";

const result = lintContent('{{ it.name || "Unknown" }}', {
    logicalOrFix: "nullish",
});

console.log(result.content);
// {{ it.name ?? "Unknown" }}
console.log(result.diagnostics);
```

`lintContent(source, options)` returns `{ changed, content, diagnostics }`. Library callers pass `LintOptions` directly; the exported `DEFAULT_LINT_OPTIONS` documents the defaults. The JSON config file and `--config` flag belong to the CLI, while the Prettier plugin has its own `sqrlLogicalOrFix` option and otherwise uses linter defaults. It does not load `.sqrl-lintrc.json`.

## Lint Configuration

For the CLI, place an optional `.sqrl-lintrc.json` in the working directory, or pass an explicit file with `--config`:

```bash
npx sqrl-lint "src/**/*.sqrl" --config config/sqrl-lint.json
```

```json
{
    "compile": true,
    "async": false,
    "logicalOrFix": "nullish",
    "knownFilters": ["date", "dateInput", "fixed", "json", "scriptJson", "timeInput"],
    "unsafeRawFilters": ["json"],
    "noImplicitNullOutput": false,
    "forbidExecute": false,
    "forbidSafe": false,
    "overrides": [
        {
            "files": "src/views/client/**/*.sqrl",
            "excludedFiles": ["src/views/client/vendor/**"],
            "options": {
                "forbidExecute": true,
                "forbidSafe": true
            }
        }
    ]
}
```

- `knownFilters` enables a complete registry check. Squirrelly's built-in `e` filter and non-async `safe` raw-output marker are always accepted; an `async safe` callable must be explicitly registered.
- `logicalOrFix` accepts `"parenthesize"` (the semantics-preserving default) or `"nullish"` to replace exposed `||` fallbacks with `??`. Set Prettier's `sqrlLogicalOrFix` to the same strategy when using the plugin.
- `unsafeRawFilters` identifies serializers that must not be emitted through `{{* ... }}` or a chain containing `safe`.
- `noImplicitNullOutput` safely adds an empty-string fallback to simple optional-chain output expressions.
- `forbidExecute` and `forbidSafe` support restricted surfaces such as templates compiled into browser JavaScript.
- `compile` defaults to `true`; disable it only for projects that intentionally use nonstandard syntax the installed Squirrelly engine cannot compile.
- `async` enables Squirrelly's async-template compilation mode for templates that legitimately contain `await`.

### Per-Glob Overrides

`overrides` applies partial lint options to matching files within the same invocation. Each entry requires `files`, accepts optional `excludedFiles`, and contains its lint settings in `options`. A pattern may be one string or an array of strings. Patterns use forward slashes and are resolved relative to the directory where `sqrl-lint` runs, including when `--config` points elsewhere.

Matching entries are merged in declaration order after the base configuration, so later entries deterministically win. Array settings replace earlier arrays instead of being concatenated. An explicit `--stdin-filepath` participates in the same matching without requiring that path to exist, which keeps editor and file-mode policy consistent; anonymous stdin uses only the base configuration.

Negated patterns are rejected; use `excludedFiles` so inclusion and precedence stay explicit. Absolute patterns, backslash path separators, unknown override properties, nested `overrides`, and invalid option values are operational configuration errors with exit code `2`.

Configuration is strict: misspelled keys, invalid types, empty filter names, and duplicates are operational errors with exit code `2`.

## Package Script Integration

Because this is a standard ecosystem plugin, you can easily wire it into your `@ynode` `lint:guardrails` group alongside CSS and HTML linting:

```json
"scripts": {
    "lint:sqrl:format": "sqrl-lint \"src/**/*.sqrl\"",
    "lint:sqrl:format:fix": "sqrl-lint \"src/**/*.sqrl\" --fix",
    "lint:guardrails": "npm run lint:css && npm run lint:sqrl:format"
}
```

## Known Limitations

### Literal Opening Double-Braces and Custom Delimiters

The tag-aware scanner treats every `{{` sequence as the start of a Squirrelly tag and does not support custom tag delimiters. If a template needs to emit a literal opening double-brace or embed foreign Vue.js or Handlebars syntax, move the content to a partial that the linter does not process or exclude it with `--ignore`. Disabling engine compilation does not disable the tag scanner. Leading regex expressions are parenthesized when that is unambiguous; delimiter-containing or irreducibly ambiguous regex/block-close sequences are reported and left unchanged.

## License

[MIT](LICENSE)
