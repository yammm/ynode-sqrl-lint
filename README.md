# @ynode/sqrl-lint

A dedicated, lightning-fast AST regex parser and formatter for Squirrelly (`.sqrl`) templates, built specifically for the `@ynode` Fastify ecosystem.

## Features

- **Strict Formatting:** Enforces consistent spacing for helpers (`{{@`, `{{#`), base brackets (`{{`, `}}`), raw outputs (`{{{`, `}}}`), and block closures (`{{/`).
- **Read-Only Linters:** Fails CI pipelines seamlessly by returning exit code `1` when files violate spacing norms.
- **Lightning Fast:** Analyzes and natively formats files in sub-millisecond per-file times, with CLI timing metrics built-in.
- **Quality of Life:** Automatically ignores `node_modules` by default and presents beautiful, colorized error logs and success reports.
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

### Auto-Fix Formatting

```bash
npx sqrl-lint "src/**/*.sqrl" --fix
```

Automatically targets syntax violations and corrects the text natively. The process exits with code `0`.

## Configuration in `package.json`

Because this is a standard ecosystem plugin, you can easily wire it into your `@ynode` `lint:guardrails` group alongside CSS and HTML linting:

```json
"scripts": {
    "lint:sqrl:format": "sqrl-lint \"src/**/*.sqrl\"",
    "lint:sqrl:format:fix": "sqrl-lint \"src/**/*.sqrl\" --fix",
    "lint:guardrails": "npm run lint:css && npm run lint:sqrl:format"
}
```

## License

[MIT](LICENSE)
