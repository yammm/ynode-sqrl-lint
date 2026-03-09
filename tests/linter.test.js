import assert from "node:assert";
import test from "node:test";

import { lintContent, rules } from "../src/linter.js";

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

test("Tag-aware scanner does not modify content outside tags", async (t) => {
    await t.test("leaves literal }} in plain text untouched", () => {
        const result = lintContent("Use x}} in your code");
        assert.strictEqual(result.changed, false);
        assert.strictEqual(result.content, "Use x}} in your code");
    });

    await t.test("leaves CSS braces untouched", () => {
        const result = lintContent("<style>.foo { color: red; }}</style>");
        assert.strictEqual(result.changed, false);
    });

    await t.test("leaves JavaScript object literals untouched", () => {
        const input = "<script>const x = {a: 1}};</script>";
        const result = lintContent(input);
        assert.strictEqual(result.changed, false);
    });

    await t.test("formats tags within surrounding plain text", () => {
        const result = lintContent("Hello {{name}}, welcome!");
        assert.strictEqual(result.content, "Hello {{ name }}, welcome!");
        assert.strictEqual(result.changed, true);
    });
});

test("Handles newlines inside tags consistently", () => {
    const result = lintContent("{{\nfoo\n}}");
    // Both sides of the inner content should be normalised
    assert.strictEqual(result.changed, true);
    assert.ok(result.content.startsWith("{{"));
    assert.ok(result.content.endsWith("}}"));
});

test("Unclosed tags are passed through unchanged", () => {
    const input = "some {{unclosed tag content";
    const result = lintContent(input);
    assert.strictEqual(result.content, input);
    assert.strictEqual(result.changed, false);
});

test("Rules array is exported and well-formed", () => {
    assert.ok(Array.isArray(rules));
    assert.ok(rules.length >= 4);
    for (const rule of rules) {
        assert.ok(typeof rule.name === "string", `rule name should be a string`);
        assert.ok(rule.pattern instanceof RegExp, `${rule.name}: pattern should be a RegExp`);
        assert.ok(typeof rule.replacement === "string", `${rule.name}: replacement should be a string`);
    }
});
