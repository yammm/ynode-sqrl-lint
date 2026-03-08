import assert from "node:assert";
import test from "node:test";

import { lintContent } from "../src/linter.js";

test("Squirrelly Linter AST Compilation suite", async (t) => {
    await t.test("Rule 1: Formats Raw Output Interpolations", () => {
        const result = lintContent("{{{data}}}");
        assert.strictEqual(result.changed, true);
        assert.strictEqual(result.content, "{{{ data }}}");

        // Assert already-clean syntax remains unchanged
        const clean = lintContent("{{{ data }}}");
        assert.strictEqual(clean.changed, false);
    });

    await t.test("Rule 2: Formats Helpers and Macros", () => {
        const partialResult = lintContent("{{@extends()}}");
        assert.strictEqual(partialResult.content, "{{@ extends() }}");

        const logicResult = lintContent("{{ #if(true) }}");
        assert.strictEqual(logicResult.content, "{{# if(true) }}");

        const commentResult = lintContent("{{ ! Todo }}");
        assert.strictEqual(commentResult.content, "{{! Todo }}");
    });

    await t.test("Rule 3: Formats Closing block start tags", () => {
        const result = lintContent("{{ / extends }}");
        assert.strictEqual(result.changed, true);
        assert.strictEqual(result.content, "{{/ extends }}");
    });

    await t.test("Rule 4: Formats Standard Base Tag Spacing", () => {
        const result = lintContent("{{name}}");
        assert.strictEqual(result.changed, true);
        assert.strictEqual(result.content, "{{ name }}");
    });

    await t.test("Rule 5: Formats Self-Closing Tag Terminations", () => {
        const result = lintContent("{{@ custom()/}}");
        assert.strictEqual(result.changed, true);
        assert.strictEqual(result.content, "{{@ custom() /}}");

        const messyResult = lintContent("{{@ proxy()  /  }}");
        assert.strictEqual(messyResult.content, "{{@ proxy() /}}");
    });

    await t.test("Rule 6: Formats Standard End Tag Spacing", () => {
        const baseResult = lintContent("{{ name}}");
        assert.strictEqual(baseResult.changed, true);
        assert.strictEqual(baseResult.content, "{{ name }}");

        // Comprehensive dirty template string
        const dirtyFull = lintContent("{{@extends()    /}}");
        assert.strictEqual(dirtyFull.content, "{{@ extends() /}}");

        const dirtyVariable = lintContent("{{   foo.bar   }}");
        assert.strictEqual(dirtyVariable.content, "{{ foo.bar }}");

        const cleanVariable = lintContent("{{ foo.bar }}");
        assert.strictEqual(cleanVariable.changed, false);
    });
});
