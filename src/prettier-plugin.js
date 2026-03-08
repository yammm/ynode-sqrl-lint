import { lintContent } from "./linter.js";

/**
 * Defines the languages that this Prettier plugin supports.
 * Maps the .sqrl extension to the custom sqrl-parse parser.
 *
 * @type {Array<Object>}
 */
export const languages = [
    {
        name: "Squirrelly",
        parsers: ["sqrl-parse"],
        extensions: [".sqrl"],
        vscodeLanguageIds: ["squirrelly"],
    },
];

/**
 * Defines the parsers for the Prettier plugin.
 * The custom parser intercepts the text, passes it through the regex-based linter,
 * and returns a pseudo-AST node.
 *
 * @type {Record<string, Object>}
 */
export const parsers = {
    "sqrl-parse": {
        /**
         * Parses the raw code into an AST format.
         *
         * @param {string} text - The raw file content to format.
         * @returns {object} The parsed AST node.
         */
        parse: (text) => {
            // Our linter is regex-based and doesn't generate a traditional AST.
            // We just return the formatted string wrapped in a pseudo-AST node.
            const result = lintContent(text);
            return {
                type: "root",
                value: result.content,
            };
        },
        astFormat: "sqrl-ast",
        locStart: () => 0,
        locEnd: () => 0,
    },
};

/**
 * Defines the printers for the Prettier plugin.
 * The custom printer simply extracts the formatted string from our pseudo-AST.
 *
 * @type {Record<string, Object>}
 */
export const printers = {
    "sqrl-ast": {
        /**
         * Prints the AST node back into a string.
         *
         * @param {Object} path - The AST path being printed.
         * @returns {string} The formatted string.
         */
        print: (path) => {
            const node = path.getValue();
            return node.value;
        },
    },
};
