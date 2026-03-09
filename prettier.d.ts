import type { Parser, Printer, SupportLanguage } from "prettier";

/**
 * Languages supported by this Prettier plugin.
 */
export declare const languages: SupportLanguage[];

/**
 * Custom parsers for Squirrelly templates.
 * The `sqrl-parse` parser runs the linter and wraps the result in a pseudo-AST.
 */
export declare const parsers: Record<string, Parser>;

/**
 * Custom printers for the `sqrl-ast` format.
 * Extracts the formatted string from the pseudo-AST produced by the parser.
 */
export declare const printers: Record<string, Printer>;
