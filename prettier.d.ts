import type {
    ChoiceSupportOption,
    Parser,
    Printer,
    SupportLanguage,
    SupportOptions,
} from "prettier";

declare module "prettier" {
    interface Options {
        /** Choose how the Squirrelly plugin repairs exposed logical OR expressions. */
        sqrlLogicalOrFix?: "parenthesize" | "nullish";
    }
}

/** Typed Squirrelly-specific option definitions exported to Prettier. */
export interface SqrlPrettierOptions extends SupportOptions {
    sqrlLogicalOrFix: ChoiceSupportOption<"parenthesize" | "nullish">;
}

/**
 * Languages supported by this Prettier plugin.
 */
export declare const languages: SupportLanguage[];

/** Squirrelly-specific options exposed through Prettier configuration. */
export declare const options: SqrlPrettierOptions;

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
