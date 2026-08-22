import assert from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { lintContent, rules } from "../src/linter.js";

const execFileAsync = promisify(execFile);

test("Squirrelly Linter AST Compilation suite", async (t) => {
    await t.test("Rule 1: Formats Raw Output Interpolations", () => {
        const result = lintContent("{{*data}}");
        assert.strictEqual(result.changed, true);
        assert.strictEqual(result.content, "{{* data }}");

        // Assert already-clean syntax remains unchanged
        const clean = lintContent("{{* data }}");
        assert.strictEqual(clean.changed, false);
    });

    await t.test("Rule 2: Formats Helpers and Macros", () => {
        const partialResult = lintContent("{{@extends()}}");
        assert.strictEqual(partialResult.content, "{{@ extends() }}");

        const logicResult = lintContent("{{ #if(true) }}");
        assert.strictEqual(logicResult.content, "{{# if(true) }}");

        const executionResult = lintContent("{{!it.ready = true; }}");
        assert.strictEqual(executionResult.content, "{{! it.ready = true; }}");
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

    await t.test("Self-closing rule does not split */ inside execution block comments", () => {
        // Regression: the [@#!] prefix class let the self-closing pattern
        // backtrack the `/` from a `*/` JavaScript-comment terminator onto
        // the self-close slash, turning `{{! /* … */ }}` into
        // `{{! /* … * /}}`.
        const input = "{{! /* This is a valid comment */ }}";
        const result = lintContent(input);
        assert.strictEqual(
            result.content,
            input,
            "execution comment containing */ must round-trip unchanged",
        );
        assert.strictEqual(result.changed, false);

        // The same content with no leading space inside is also preserved.
        const tight = "{{!/* boundary case */}}";
        const tightResult = lintContent(tight);
        assert.strictEqual(tightResult.content, "{{! /* boundary case */ }}");

        // Block-open tags (`{{# ... }}`) also must not be treated as
        // self-closing just because their content ends in `/`.
        const block = "{{#if (path === '/') }}";
        const blockResult = lintContent(block);
        assert.strictEqual(blockResult.content, "{{# if (path === '/') }}");
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
    for (const input of ["{{\nfoo\n}}", "{{\r\nfoo\r\n}}"]) {
        const result = lintContent(input);
        assert.strictEqual(result.changed, false);
        assert.strictEqual(result.content, input);
        assert.ok(
            result.content.split(/\r?\n/u).every((line) => !/[ \t]+$/u.test(line)),
            "formatting must not introduce trailing whitespace",
        );
    }
});

test("Close-delimiter scanner respects nested JavaScript syntax", async (t) => {
    const cases = [
        ["nested object braces", "{{fmt({a:{b:1}})}}", "{{ fmt({a:{b:1}}) }}"],
        ["double-quoted delimiter", '{{"literal }} text"}}', '{{ "literal }} text" }}'],
        ["single-quoted delimiter", "{{'literal }} text'}}", "{{ 'literal }} text' }}"],
        ["escaped quote delimiter", '{{"escaped \\" }} text"}}', '{{ "escaped \\" }} text" }}'],
        ["block-comment delimiter", "{{fn(/* }} */ value)}}", "{{ fn(/* }} */ value) }}"],
        [
            "line-comment delimiter",
            "{{fn(\n// }} ignored\nvalue\n)}}",
            "{{ fn(\n// }} ignored\nvalue\n) }}",
        ],
        ["escaped regex delimiter", "{{/\\}\\}/.test(value)}}", "{{ (/\\}\\}/.test(value)) }}"],
        [
            "nested template expression",
            '{{`${({ value: "}}" }).value}`}}',
            '{{ `${({ value: "}}" }).value}` }}',
        ],
        ["raw-output nested braces", "{{*({a:{b:1}})}}", "{{* ({a:{b:1}}) }}"],
    ];

    for (const [name, input, expected] of cases) {
        await t.test(name, () => {
            const result = lintContent(input);
            assert.strictEqual(result.content, expected);
            assert.strictEqual(lintContent(result.content).changed, false);
        });
    }
});

test("Execution tags treat JavaScript block comments as opaque", () => {
    const input = "{{! /* TODO: ignore {{name}} while disabled */ }}{{next}}";
    const result = lintContent(input);
    assert.strictEqual(
        result.content,
        "{{! /* TODO: ignore {{name}} while disabled */ }}{{ next }}",
    );
    assert.strictEqual(lintContent(result.content).changed, false);
});

test("Leading regular-expression literals are disambiguated as expression tags", () => {
    const dirty = lintContent("{{/^admin/.test(it.role)}}");
    assert.strictEqual(dirty.content, "{{ (/^admin/.test(it.role)) }}");

    const clean = lintContent("{{ (/^admin/.test(it.role)) }}");
    assert.strictEqual(clean.content, "{{ (/^admin/.test(it.role)) }}");
    assert.strictEqual(clean.changed, false);
});

test("Block-close tags are not mistaken for regex literals", () => {
    const input = "{{/if}} / literal slash after the tag";
    assert.strictEqual(lintContent(input).content, "{{/ if }} / literal slash after the tag");
});

test("Ambiguous block-close and leading-regex tags pass through unchanged", () => {
    for (const input of ["{{/if}}/.test(x)}}", "{{ /foo}}/ }}"]) {
        const first = lintContent(input);
        assert.strictEqual(first.changed, false);
        assert.strictEqual(first.content, input);

        const second = lintContent(first.content);
        assert.strictEqual(second.changed, false);
        assert.strictEqual(second.content, input);
    }
});

test("Adjacent block-close tags remain unambiguous", () => {
    const input = "{{/if}}{{/each}}";
    const first = lintContent(input);
    assert.strictEqual(first.content, "{{/ if }}{{/ each }}");

    const second = lintContent(first.content);
    assert.strictEqual(second.changed, false);
    assert.strictEqual(second.content, first.content);
});

test("Empty tags normalize to one interior space", () => {
    assert.strictEqual(lintContent("{{}}").content, "{{ }}");
    assert.strictEqual(lintContent("{{ }}").changed, false);
});

test("Unclosed tags are passed through unchanged", () => {
    const input = "some {{unclosed tag content";
    const result = lintContent(input);
    assert.strictEqual(result.content, input);
    assert.strictEqual(result.changed, false);
});

test("Rules array is exported and well-formed", () => {
    assert.ok(Array.isArray(rules));
    assert.ok(Object.isFrozen(rules));
    assert.ok(rules.length >= 4);
    for (const rule of rules) {
        assert.ok(Object.isFrozen(rule), `${rule.name}: rule should be immutable`);
        assert.ok(typeof rule.name === "string", `rule name should be a string`);
        assert.ok(rule.pattern instanceof RegExp, `${rule.name}: pattern should be a RegExp`);
        assert.ok(
            typeof rule.replacement === "string",
            `${rule.name}: replacement should be a string`,
        );
    }
});

test("Exported rules preserve their documented first-match formatting semantics", () => {
    const cases = new Map([
        ["  @  custom()  /  ", "@ custom() /"],
        ["  @  custom()  ", "@ custom() "],
        ["  #  if(true)  ", "# if(true) "],
        ["  /  each  ", "/ each "],
        ["  it.name  ", " it.name "],
        ["   ", "  "],
    ]);

    for (const [input, expected] of cases) {
        const rule = rules.find(({ pattern }) => pattern.test(input));
        assert.ok(rule, `expected a public rule to match ${JSON.stringify(input)}`);
        assert.strictEqual(input.replace(rule.pattern, rule.replacement), expected);
    }
});

test("Exported rule patterns stay responsive on pathological whitespace", async () => {
    const moduleUrl = new URL("../src/linter.js", import.meta.url).href;
    const script = `
        import { rules } from ${JSON.stringify(moduleUrl)};
        const spaces = " ".repeat(50_000);
        const inputs = ["@" + spaces, "@" + spaces + "x" + spaces];
        for (const input of inputs) {
            for (const rule of rules) {
                input.replace(rule.pattern, rule.replacement);
            }
        }
        process.stdout.write("ok");
    `;

    const { stdout } = await execFileAsync(
        process.execPath,
        ["--input-type=module", "--eval", script],
        {
            timeout: 3_000,
        },
    );
    assert.strictEqual(stdout, "ok");
});

test("Formatting is idempotent across all tag types", async (t) => {
    const inputs = [
        "{{foo}}",
        "{{*bar}}",
        "{{@extends()}}",
        "{{# if(true) }}",
        "{{ / each }}",
        "{{@ custom()/}}",
        "{{   deeply.nested.prop   }}",
        "{{@extends()    /}}",
        "Hello {{name}}, welcome to {{*site}}!",
        '<div class="{{cls}}">{{# if(x) }}{{* raw }}{{/ if }}</div>',
        "plain text with no tags at all",
        "some {{unclosed tag content",
    ];

    for (const input of inputs) {
        await t.test(`idempotent: ${JSON.stringify(input).slice(0, 50)}`, () => {
            const first = lintContent(input);
            const second = lintContent(first.content);
            assert.strictEqual(
                second.changed,
                false,
                `Second pass should not change output for: ${input}`,
            );
            assert.strictEqual(second.content, first.content);
        });
    }
});

test("Pathological whitespace runs inside tags are linted in linear time", () => {
    // A `{{@` tag body holding a long space run with no self-closing `/`
    // previously drove the `helper-self-closing` regex into ~O(n^3)
    // backtracking (8,000 spaces did not finish within 47 seconds).
    const inputs = [
        `{{@${" ".repeat(8000)}}}`,
        `{{@\t${" \t".repeat(4000)}}}`,
        `{{#${" ".repeat(8000)}}}`,
        `{{${" ".repeat(8000)}x${" ".repeat(8000)}}}`,
    ];

    for (const input of inputs) {
        const startTime = performance.now();
        const result = lintContent(input, { compile: false });
        const elapsedMs = performance.now() - startTime;
        assert.ok(typeof result.content === "string");
        assert.ok(
            elapsedMs < 2000,
            `linting took ${Math.round(elapsedMs)}ms for ${input.length} chars`,
        );
    }
});

test("Pathological whitespace formatting matches the declarative rules", () => {
    assert.strictEqual(
        lintContent(`{{@${" ".repeat(64)}}}`, { compile: false }).content,
        "{{@  }}",
    );
    assert.strictEqual(
        lintContent(`{{@${" ".repeat(64)}/}}`, { compile: false }).content,
        "{{@  /}}",
    );
});
