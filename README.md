# @ynode/sqrl-lint

Copyright (c) 2026 Michael Welter <me@mikinho.com>

[![npm version](https://img.shields.io/npm/v/@ynode/sqrl-lint.svg)](https://www.npmjs.com/package/@ynode/sqrl-lint)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A dedicated, lightning-fast linter and formatter for Squirrelly (`.sqrl`) templates, built specifically for the `@ynode`
Fastify ecosystem. Uses a tag-aware scanner to normalise spacing only inside `{{ ... }}` boundaries, leaving surrounding
HTML, CSS, and JS untouched.

## Features

- **Strict Formatting:** Enforces consistent spacing for helpers (`{{@`, `{{#`), base brackets (`{{`, `}}`), raw outputs
  (`{{{`, `}}}`), and block closures (`{{/`).
- **Read-Only Linters:** Fails CI pipelines seamlessly by returning exit code `1` when files violate spacing norms.
- **Lightning Fast:** Analyzes and natively formats files in sub-millisecond per-file times, with CLI timing metrics
  built-in.
- **Quality of Life:** Automatically ignores `node_modules` by default and presents beautiful, colorized error logs and
  success reports.
- **Auto-Repair:** The `--fix` option seamlessly rewrites dirty files back to pristine format natively.
- **Fast-Glob Powered:** Built-in `fast-glob` processing natively supports arbitrary inclusion and exclusion targeting.

## Installation

```bash
npm install -D @ynode/sqrl-lint
```

## Usage

You can use the linter either manually via `npx` or wire it directly into your `package.json` scripts block.

### Check Formatting (Read-Only)

```bash
npx sqrl-lint "src/**/*.sqrl"
```

If any files are formatted improperly, an error will be logged to `stderr` and the process will exit with code `1`.
Processing errors (I/O failures, invalid arguments) exit with code `2`.

### Auto-Fix Formatting

```bash
npx sqrl-lint "src/**/*.sqrl" --fix
```

Automatically targets syntax violations and corrects the text natively. The process exits with code `0`.

### JSON Reporting

```bash
npx sqrl-lint "src/**/*.sqrl" --report json
```

Emits a machine-readable JSON summary to `stdout`, suitable for CI/log parsers.

### Disable ANSI Colors

```bash
npx sqrl-lint "src/**/*.sqrl" --no-color
```

Disables ANSI color styling in text output.

### Show Diffs (Check Mode)

```bash
npx sqrl-lint "src/**/*.sqrl" --diff
```

Shows a unified diff for each file that needs formatting, making CI failures actionable.

### Parallel Processing

```bash
npx sqrl-lint "src/**/*.sqrl" --fix --concurrency 4
```

Processes files with bounded parallelism for faster runs on large repositories.

### Stdin / Editor Integration

```bash
cat src/views/home.sqrl | npx sqrl-lint --stdin --fix
```

Reads template content from stdin and writes the formatted output to stdout, making it ideal for editor "format on save"
integrations, shell pipelines, and git hooks. Use `--stdin-filepath <path>` to control the filename shown in error
messages and diffs.

### Quiet Mode

```bash
npx sqrl-lint "src/**/*.sqrl" --quiet
```

Suppresses all output; only the exit code indicates the result (0 = pass, 1 = lint failure, 2 = error).

## Formatting Rules

The linter enforces consistent spacing inside Squirrelly tag boundaries. Rules are applied in order; the first match
wins.

| Tag Type            | Before               | After                  |
| ------------------- | -------------------- | ---------------------- |
| Helper / Macro open | `{{@extends()}}`     | `{{@ extends() }}`     |
| Helper / Macro open | `{{#if(user)}}`      | `{{# if(user) }}`      |
| Self-closing helper | `{{@partial("x")/}}` | `{{@ partial("x") /}}` |
| Block close         | `{{/if}}`            | `{{/ if }}`            |
| Expression          | `{{name}}`           | `{{ name }}`           |
| Raw output (triple) | `{{{rawHtml}}}`      | `{{{ rawHtml }}}`      |

Content outside `{{ ... }}` boundaries (HTML, CSS, JS) is never modified.

## Prettier Integration

The package ships a Prettier plugin so you can format `.sqrl` files alongside the rest of your codebase:

```json
{
    "plugins": ["@ynode/sqrl-lint/prettier"]
}
```

Once configured, `prettier --write "**/*.sqrl"` will apply the same tag-spacing rules used by the CLI.

## Configuration in `package.json`

Because this is a standard ecosystem plugin, you can easily wire it into your `@ynode` `lint:guardrails` group alongside
CSS and HTML linting:

```json
"scripts": {
    "lint:sqrl:format": "sqrl-lint \"src/**/*.sqrl\"",
    "lint:sqrl:format:fix": "sqrl-lint \"src/**/*.sqrl\" --fix",
    "lint:guardrails": "npm run lint:css && npm run lint:sqrl:format"
}
```

## Known Limitations

### Escaped / Literal Double-Braces

The tag-aware scanner treats every `{{` sequence as the start of a Squirrelly tag. There is currently no escape
mechanism for outputting a literal `{{` or `}}` in your template without it being interpreted as tag syntax. If your
templates need to emit raw double-brace strings (for example, Vue.js or Handlebars snippets embedded in a Squirrelly
layout), wrap them in a Squirrelly raw helper or move the content to a partial that the linter does not process.

## License

[MIT](LICENSE)
