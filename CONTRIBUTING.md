# Contributing

Welcome! We appreciate your help in improving the `@ynode/sqrl-lint` syntax formatter.

## Development

### Getting Started

Before contributing, please securely install the local Git hooks which enforce commit message formatting and other standards:

```bash
./scripts/setup-hooks
```

### Development Commands

```bash
# Run the standard test suite
npm run test

# Run ESLint
npm run lint

# Check Prettier formatting
npm run format:check

# Validate the packed TypeScript declarations
npm run typecheck
```

## Release Process

This package natively utilizes [`@mikinho/autover`](https://github.com/yammm/ynode-autover) for automated versioning and changelog generation.

To release a new version seamlessly:

1. Make your code changes in a branch.
2. Open a Pull Request against `main`.
3. Add the **`autover-apply`** label to the Pull Request.
4. Merge the Pull Request.

Upon merge, the GitHub Action runner will bump the package version when the merged pull request has the required label, regenerate `CHANGELOG.md`, and commit those changes directly to `main`. Automatic tag creation is currently disabled; release tags are managed separately.

> **Note:** Direct commits to `main` skip the version bump but still regenerate and commit `CHANGELOG.md`.
