import assert from "node:assert";
import test from "node:test";

import { render } from "squirrelly";

import { lintContent } from "../src/linter.js";

function ruleIds(result) {
    return result.diagnostics.map(({ ruleId }) => ruleId);
}

function diagnosticsFor(result, ruleId) {
    return result.diagnostics.filter((diagnostic) => diagnostic.ruleId === ruleId);
}

test("wraps top-level logical OR without changing JavaScript fallback semantics", () => {
    const result = lintContent('{{ it.blah || "test" }}');

    assert.strictEqual(result.content, '{{ (it.blah || "test") }}');
    assert.deepStrictEqual(ruleIds(result), ["no-unparenthesized-logical-or"]);
    assert.strictEqual(result.diagnostics[0].fixable, true);
    assert.strictEqual(render(result.content, { blah: "" }), "test");
    assert.strictEqual(render(result.content, { blah: 0 }), "test");
    assert.strictEqual(render(result.content, { blah: false }), "test");
});

test("does not replace logical OR with nullish coalescing", () => {
    const logicalOr = lintContent('{{ it.value || "fallback" }}');
    const nullish = lintContent('{{ it.value ?? "fallback" }}');

    assert.match(logicalOr.content, /\|\|/u);
    assert.doesNotMatch(logicalOr.content, /\?\?/u);
    assert.strictEqual(nullish.content, '{{ it.value ?? "fallback" }}');
    assert.deepStrictEqual(nullish.diagnostics, []);
    assert.strictEqual(render(nullish.content, { value: "" }), "");
});

test("rewrites exposed logical OR to nullish coalescing when configured", () => {
    const result = lintContent('{{ it.value || "fallback" }}', { logicalOrFix: "nullish" });

    assert.strictEqual(result.content, '{{ it.value ?? "fallback" }}');
    assert.deepStrictEqual(ruleIds(result), ["no-unparenthesized-logical-or"]);
    assert.strictEqual(result.diagnostics[0].fixable, true);
    assert.match(result.diagnostics[0].message, /configured fix rewrites it to `\?\?`/u);
    assert.strictEqual(render(result.content, { value: undefined }), "fallback");
    assert.strictEqual(render(result.content, { value: null }), "fallback");
    assert.strictEqual(render(result.content, { value: "" }), "");
    assert.strictEqual(render(result.content, { value: 0 }), "0");
    assert.strictEqual(render(result.content, { value: false }), "false");
});

test("applies nullish mode across output forms without disturbing filters or controls", () => {
    for (const [input, expected, extraOptions = {}] of [
        ['{{ it.value || "fallback" | safe }}', '{{ it.value ?? "fallback" | safe }}'],
        ['{{* it.value || "fallback" }}', '{{* it.value ?? "fallback" }}'],
        ['{{{ it.value || "fallback" }}}', '{{{ it.value ?? "fallback" }}}', { compile: false }],
        ['{{- it.value || "fallback" -}}', '{{- it.value ?? "fallback" -}}'],
    ]) {
        const options = { logicalOrFix: "nullish", ...extraOptions };
        const first = lintContent(input, options);
        const second = lintContent(first.content, options);

        assert.strictEqual(first.content, expected);
        assert.deepStrictEqual(ruleIds(first), ["no-unparenthesized-logical-or"]);
        assert.strictEqual(second.changed, false);
        assert.deepStrictEqual(second.diagnostics, []);
    }
});

test("rewrites every exposed logical OR in compound expressions", () => {
    for (const [input, expected] of [
        ['{{ it.a || it.b || "fallback" }}', '{{ it.a ?? it.b ?? "fallback" }}'],
        ['{{ [it.a || "a", it.b || "b"] }}', '{{ [it.a ?? "a", it.b ?? "b"] }}'],
        ['{{ { value: it.a || "fallback" }.value }}', '{{ { value: it.a ?? "fallback" }.value }}'],
        ['{{ it.ok ? it.a || "a" : it.b || "b" }}', '{{ it.ok ? it.a ?? "a" : it.b ?? "b" }}'],
    ]) {
        const result = lintContent(input, { logicalOrFix: "nullish" });

        assert.strictEqual(result.content, expected);
        assert.deepStrictEqual(ruleIds(result), ["no-unparenthesized-logical-or"]);
        assert.deepStrictEqual(
            lintContent(result.content, { logicalOrFix: "nullish" }).diagnostics,
            [],
        );
    }
});

test("parenthesizes AND operands when nullish mode would otherwise create invalid JavaScript", () => {
    for (const [input, expected] of [
        ['{{ it.ready && it.value || "fallback" }}', '{{ (it.ready && it.value) ?? "fallback" }}'],
        ["{{ it.value || it.ready && it.other }}", "{{ it.value ?? (it.ready && it.other) }}"],
        ["{{ it.a || it.b && it.c || it.d }}", "{{ it.a ?? (it.b && it.c) ?? it.d }}"],
        ["{{ it.value || (it.ready && it.other) }}", "{{ it.value ?? (it.ready && it.other) }}"],
    ]) {
        const result = lintContent(input, { logicalOrFix: "nullish" });

        assert.strictEqual(result.content, expected);
        assert.deepStrictEqual(ruleIds(result), ["no-unparenthesized-logical-or"]);
        assert.deepStrictEqual(
            lintContent(result.content, { logicalOrFix: "nullish" }).diagnostics,
            [],
        );
    }
});

test("nullish mode leaves protected logical OR alone", () => {
    const input = '{{ (it.value || "fallback") }}';
    const result = lintContent(input, { logicalOrFix: "nullish" });

    assert.strictEqual(result.content, input);
    assert.deepStrictEqual(result.diagnostics, []);
});

test("nullish mode falls back to parser protection for OR-like syntax it cannot safely rewrite", () => {
    const regex = lintContent("{{ it.ok ? /yes||no/.test(it.value) : false }}", {
        logicalOrFix: "nullish",
    });
    const assignment = lintContent('{{ it.page ||= "dashboard" }}', { logicalOrFix: "nullish" });

    assert.strictEqual(regex.content, "{{ (it.ok ? /yes||no/.test(it.value) : false) }}");
    assert.deepStrictEqual(ruleIds(regex), ["no-unparenthesized-logical-or"]);
    assert.match(regex.diagnostics[0].message, /could not be safely rewritten/u);
    assert.strictEqual(assignment.content, '{{ (it.page ||= "dashboard") }}');
    assert.deepStrictEqual(ruleIds(assignment), [
        "no-output-assignment",
        "no-unparenthesized-logical-or",
    ]);
    assert.doesNotMatch(assignment.content, /\?\?=/u);
});

test("nullish mode does not claim a partial JavaScript parse as a successful rewrite", () => {
    const result = lintContent("{{ it.a || it.b garbage }}", { logicalOrFix: "nullish" });

    assert.strictEqual(result.content, "{{ (it.a || it.b garbage) }}");
    assert.deepStrictEqual(ruleIds(result), [
        "valid-squirrelly-syntax",
        "no-unparenthesized-logical-or",
    ]);
    assert.match(
        diagnosticsFor(result, "no-unparenthesized-logical-or")[0].message,
        /could not be safely rewritten/u,
    );
});

test("wraps the expression before preserving a filter chain", () => {
    const result = lintContent('{{ it.value || "fallback" | safe }}');
    assert.strictEqual(result.content, '{{ (it.value || "fallback") | safe }}');
    assert.deepStrictEqual(ruleIds(result), ["no-unparenthesized-logical-or"]);
});

test("detects filter-depth OR inside arrays and objects", () => {
    for (const [input, expected] of [
        ['{{ [it.value || "fallback"] }}', '{{ ([it.value || "fallback"]) }}'],
        [
            '{{ { value: it.value || "fallback" }.value }}',
            '{{ ({ value: it.value || "fallback" }.value) }}',
        ],
    ]) {
        const result = lintContent(input);
        assert.strictEqual(result.content, expected);
        assert.deepStrictEqual(ruleIds(result), ["no-unparenthesized-logical-or"]);
    }
});

test("protects a leading regex before Squirrelly can parse its OR as filters", () => {
    const result = lintContent("{{ /yes||no/.test(it.value) }}");
    assert.strictEqual(result.content, "{{ (/yes||no/.test(it.value)) }}");
    assert.deepStrictEqual(ruleIds(result), ["no-ambiguous-leading-prefix"]);
});

test("allows logical OR already protected by parentheses", () => {
    for (const input of [
        '{{ (it.value || "fallback") }}',
        '{{ [1].map((value) => value || "fallback") }}',
        "{{@ if(it.value || it.other) }}yes{{/ if }}",
    ]) {
        const result = lintContent(input);
        assert.strictEqual(result.content, input);
        assert.strictEqual(diagnosticsFor(result, "no-unparenthesized-logical-or").length, 0);
    }
});

test("ignores OR-looking text inside JavaScript literals and comments", () => {
    for (const input of [
        '{{ "left || right" }}',
        "{{ 'left || right' }}",
        "{{ (`left || right`) }}",
        "{{ (it.value /* || fallback */) }}",
    ]) {
        const result = lintContent(input);
        assert.strictEqual(result.content, input);
        assert.strictEqual(diagnosticsFor(result, "no-unparenthesized-logical-or").length, 0);
    }

    const regex = lintContent("{{ /a[|][|]b/.test(it.value) }}");
    assert.strictEqual(regex.content, "{{ (/a[|][|]b/.test(it.value)) }}");
    assert.strictEqual(diagnosticsFor(regex, "no-unparenthesized-logical-or").length, 0);
    assert.strictEqual(diagnosticsFor(regex, "no-ambiguous-leading-prefix").length, 1);
});

test("reports but does not guess how to rewrite top-level OR in execution tags", () => {
    const input = '{{! it.page = it.page || "dashboard"; }}';
    const result = lintContent(input);

    assert.strictEqual(result.content, input);
    assert.deepStrictEqual(ruleIds(result), ["no-unparenthesized-logical-or"]);
    assert.strictEqual(result.diagnostics[0].fixable, false);
});

test("does not let whitespace disguise an execution prefix", () => {
    const ambiguous = lintContent("{{ !it.enabled }}");

    assert.strictEqual(ambiguous.content, "{{ !it.enabled }}");
    assert.deepStrictEqual(ruleIds(ambiguous), ["no-ambiguous-leading-prefix"]);
    assert.strictEqual(ambiguous.diagnostics[0].fixable, false);
    assert.deepStrictEqual(
        diagnosticsFor(lintContent("{{! it.enabled = true; }}"), "no-ambiguous-leading-prefix"),
        [],
    );
    assert.deepStrictEqual(
        diagnosticsFor(lintContent("{{ (!it.enabled) }}"), "no-ambiguous-leading-prefix"),
        [],
    );
});

test("parenthesizes a leading regex expression that resembles a block close", () => {
    for (const [input, expected] of [
        ["{{ /x/.test(it.value) }}", "{{ (/x/.test(it.value)) }}"],
        ["{{ /a|b/.test(it.value) }}", "{{ (/a|b/.test(it.value)) }}"],
        ["{{ /[|]/.test(it.value) | e }}", "{{ (/[|]/.test(it.value)) | e }}"],
    ]) {
        const result = lintContent(input);

        assert.strictEqual(result.content, expected);
        assert.deepStrictEqual(ruleIds(result), ["no-ambiguous-leading-prefix"]);
        assert.strictEqual(result.diagnostics[0].fixable, true);
        assert.deepStrictEqual(lintContent(result.content).diagnostics, []);
    }
});

test("does not claim it can repair a regex containing the active close delimiter", () => {
    const input = "{{ /}}|x/.test(it.value) }}";
    const result = lintContent(input);
    const finding = diagnosticsFor(result, "no-ambiguous-leading-prefix")[0];

    assert.strictEqual(result.content, input);
    assert.strictEqual(finding.fixable, false);
    assert.match(finding.message, /Escape the braces/u);
    assert.strictEqual(diagnosticsFor(result, "valid-squirrelly-syntax").length, 1);
});

test("ignores logical-OR text inside execution line comments", () => {
    for (const input of [
        "{{! // documented a || b }}ok",
        "{{! const value = 1; // documented a || b }}ok",
    ]) {
        assert.strictEqual(
            diagnosticsFor(lintContent(input), "no-unparenthesized-logical-or").length,
            0,
        );
    }
});

test("fixes every historically invalid else-if spelling", () => {
    for (const invalid of ["else if", "elseif", "elf"]) {
        const input = `{{@ if(it.first) }}first{{# ${invalid}(it.second) }}second{{# else }}last{{/ if }}`;
        const result = lintContent(input);

        assert.strictEqual(
            result.content,
            "{{@ if(it.first) }}first{{# elif(it.second) }}second{{# else }}last{{/ if }}",
        );
        assert.deepStrictEqual(ruleIds(result), ["valid-elif"]);
        assert.strictEqual(render(result.content, { first: false, second: true }), "second");
    }
});

test("reports orphan, duplicate, and out-of-order native branches", () => {
    const cases = [
        ["{{# elif(it.ok) }}", /open `if`/u],
        ["{{@ if(it.ok) }}x{{# else }}y{{# else }}z{{/ if }}", /only one `else`/u],
        ["{{@ if(it.ok) }}x{{# else }}y{{# elif(it.other) }}z{{/ if }}", /after `else`/u],
        ["{{@ if(it.ok) }}x{{# elif() }}y{{/ if }}", /requires a condition/u],
        ["{{@ if(it.ok) }}x{{# else(it.other) }}y{{/ if }}", /does not accept a condition/u],
        ["{{@ if(it.ok) }}x{{# else typo }}y{{/ if }}", /Unknown `else typo` block/u],
    ];

    for (const [input, expectedMessage] of cases) {
        const result = lintContent(input, { compile: false });
        const findings = diagnosticsFor(result, "valid-native-branch");
        assert.ok(findings.length >= 1, input);
        assert.match(findings.at(-1).message, expectedMessage);
    }
});

test("allows arbitrary blocks owned by custom helpers", () => {
    const input = "{{@ custom() }}first{{# else }}second{{# elseif(it.ok) }}third{{/ custom }}";
    const result = lintContent(input);
    assert.strictEqual(result.content, input);
    assert.strictEqual(diagnosticsFor(result, "valid-native-branch").length, 0);
    assert.strictEqual(diagnosticsFor(result, "valid-elif").length, 0);
});

test("does not auto-fix newline-separated or condition-less elif misspellings", () => {
    for (const input of [
        "{{@ if(it.ok) }}x{{# else\nif(it.other) }}y{{/ if }}",
        "{{@ if(it.ok) }}x{{# elseif }}y{{/ if }}",
    ]) {
        const result = lintContent(input, { compile: false });
        assert.strictEqual(result.content, input);
        const finding = diagnosticsFor(result, "valid-elif")[0];
        assert.strictEqual(finding.fixable, false);
        assert.doesNotMatch(finding.message, /\n/u);
    }
});

test("reports output assignments without changing possible intentional output", () => {
    for (const input of [
        '{{ it.page = "dashboard" }}',
        "{{ it.count += 1 }}",
        '{{ (it.page = "dashboard") }}',
        "{{ ++it.count }}",
        "{{ it.count-- }}",
    ]) {
        const result = lintContent(input);
        assert.strictEqual(result.content, input);
        assert.deepStrictEqual(ruleIds(result), ["no-output-assignment"]);
        assert.strictEqual(result.diagnostics[0].fixable, false);
    }
});

test("reports destructuring and nested computed output assignments", () => {
    for (const input of [
        "{{ ({ x: it.x } = source) }}",
        "{{ [it.x] = source }}",
        "{{ it.a[it.keys[0]] = 1 }}",
        "{{ (prepare(), it.x = 1) }}",
    ]) {
        const result = lintContent(input, { compile: false });
        assert.strictEqual(diagnosticsFor(result, "no-output-assignment").length, 1, input);
    }
});

test("does not promote assignments nested inside callbacks or calls", () => {
    for (const input of [
        "{{ items.map((item = fallback) => item) }}",
        "{{ choose(assign(it.x = 1)) }}",
        "{{ /a=b/.test(it.value) }}",
        "{{ () => it.x++ }}",
        "{{ async value => value = 1 }}",
    ]) {
        const result = lintContent(input, { compile: false });
        assert.strictEqual(diagnosticsFor(result, "no-output-assignment").length, 0, input);
    }
});

test("retains output-mutation diagnostics when a logical assignment also needs parser protection", () => {
    const result = lintContent('{{ it.page ||= "dashboard" }}');
    assert.strictEqual(result.content, '{{ (it.page ||= "dashboard") }}');
    assert.deepStrictEqual(ruleIds(result), [
        "no-output-assignment",
        "no-unparenthesized-logical-or",
    ]);
});

test("does not mistake comparisons or arrows for output assignments", () => {
    for (const input of [
        '{{ it.page == "dashboard" }}',
        '{{ it.page === "dashboard" }}',
        "{{ ((value) => value)(it.page) }}",
        "{{ it.count >= 1 }}",
    ]) {
        assert.strictEqual(diagnosticsFor(lintContent(input), "no-output-assignment").length, 0);
    }
});

test("compiles templates and reports engine syntax failures", () => {
    for (const input of ["{{@ if(true) }}unclosed", "{{! /* unclosed }}", "{{ it. }}"]) {
        const result = lintContent(input);
        const findings = diagnosticsFor(result, "valid-squirrelly-syntax");
        assert.strictEqual(findings.length, 1, input);
        assert.match(findings[0].message, /Squirrelly|Unclosed/u);
    }
});

test("supports Squirrelly async-template compilation", () => {
    const input = "{{! const value = await Promise.resolve(1); }}";
    assert.deepStrictEqual(ruleIds(lintContent(input)), ["valid-squirrelly-syntax"]);
    assert.deepStrictEqual(lintContent(input, { async: true }).diagnostics, []);
});

test("recognizes async native helpers when repairing branches", () => {
    for (const [input, expected] of [
        [
            "{{@ async if(await Promise.resolve(false)) }}first{{# elseif(true) }}second{{/ if }}",
            "{{@ async if(await Promise.resolve(false)) }}first{{# elif(true) }}second{{/ if }}",
        ],
        [
            "{{@ async if(await Promise.resolve(false)) }}first{{# async elseif(true) }}second{{/ if }}",
            "{{@ async if(await Promise.resolve(false)) }}first{{# async elif(true) }}second{{/ if }}",
        ],
    ]) {
        const result = lintContent(input, { async: true });
        assert.strictEqual(result.content, expected);
        assert.deepStrictEqual(ruleIds(result), ["valid-elif"]);
    }
});

test("requires async mode for async helper and filter modifiers", () => {
    const helper = lintContent('{{@ async include("item") /}}', { compile: false });
    const filter = lintContent("{{ it.value | async format }}", {
        compile: false,
        knownFilters: ["format"],
    });

    assert.deepStrictEqual(ruleIds(helper), ["valid-async-syntax"]);
    assert.deepStrictEqual(ruleIds(filter), ["valid-async-syntax"]);
    assert.deepStrictEqual(
        lintContent("{{ it.value | async format }}", {
            async: true,
            compile: false,
            knownFilters: ["format"],
        }).diagnostics,
        [],
    );
});

test("does not confuse an async safe filter with the raw safe marker", () => {
    const unknown = lintContent("{{ it.value | async safe }}", {
        async: true,
        compile: false,
        forbidSafe: true,
        knownFilters: [],
    });
    const configured = lintContent("{{ it.value | async safe }}", {
        async: true,
        compile: false,
        forbidSafe: true,
        knownFilters: ["safe"],
    });
    assert.deepStrictEqual(ruleIds(unknown), ["known-filter"]);
    assert.deepStrictEqual(configured.diagnostics, []);
});

test("compile checks can be disabled for nonstandard projects", () => {
    const result = lintContent("{{ it. }}", { compile: false });
    assert.deepStrictEqual(result.diagnostics, []);
});

test("unclosed template tags remain an error even when engine compilation is disabled", () => {
    const result = lintContent("line one\n{{ it.value", { compile: false });
    assert.strictEqual(result.content, "line one\n{{ it.value");
    assert.deepStrictEqual(ruleIds(result), ["valid-squirrelly-syntax"]);
    assert.deepStrictEqual(
        { line: result.diagnostics[0].line, column: result.diagnostics[0].column },
        { line: 2, column: 1 },
    );
});

test("execution block comments can contain dormant Sqrl text without hiding later tags", () => {
    const input = "{{! /* hidden {{@ if(ok) }}x{{/ if }} */ }}\n{{foo}}";
    const result = lintContent(input);

    assert.strictEqual(result.content, "{{! /* hidden {{@ if(ok) }}x{{/ if }} */ }}\n{{ foo }}");
    assert.deepStrictEqual(result.diagnostics, []);
});

test("execution line comments close where Squirrelly closes them", () => {
    const input = "{{! // ignored }}<div>{{name}}</div>";
    const result = lintContent(input);
    assert.strictEqual(result.content, "{{! // ignored }}<div>{{ name }}</div>");
    assert.deepStrictEqual(result.diagnostics, []);
});

test("preserves Squirrelly whitespace-control markers", () => {
    for (const [input, expected] of [
        ["{{-value}}", "{{- value }}"],
        ["{{value-}}", "{{ value -}}"],
        ["{{_value_}}", "{{_ value _}}"],
        ["{{-@if(it.ok)-}}yes{{/if}}", "{{-@ if(it.ok) -}}yes{{/ if }}"],
    ]) {
        const result = lintContent(input);
        assert.strictEqual(result.content, expected);
        assert.strictEqual(lintContent(result.content).changed, false);
    }
});

test("formats Squirrelly raw-output tags with an attached prefix", () => {
    const result = lintContent("{{ *it.html }}");
    assert.strictEqual(result.content, "{{* it.html }}");
    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(
        render(result.content, { html: "<strong>ok</strong>" }),
        "<strong>ok</strong>",
    );
});

test("reports unknown configured filters with a conservative suggestion", () => {
    const result = lintContent("{{ it.start | time }}", {
        knownFilters: ["dateInput", "timeInput", "scriptJson"],
    });
    const findings = diagnosticsFor(result, "known-filter");

    assert.strictEqual(findings.length, 1);
    assert.match(findings[0].message, /Unknown Squirrelly filter `time`/u);
    assert.match(findings[0].message, /Did you mean `timeInput`/u);
});

test("always allows Squirrelly built-in filters in a configured registry", () => {
    const result = lintContent("{{ it.html | safe }} {{ it.text | e }}", { knownFilters: [] });
    assert.strictEqual(diagnosticsFor(result, "known-filter").length, 0);
});

test("reports unsafe raw JSON and configured serializer chains", () => {
    const raw = lintContent("{{ JSON.stringify(it.payload) | safe }}");
    const rawPrefix = lintContent("{{* JSON.stringify(it.payload) }}");
    const configured = lintContent("{{ it.payload | json | safe }}", {
        unsafeRawFilters: ["json"],
    });
    const safeFirst = lintContent("{{ it.payload | safe | json }}", {
        unsafeRawFilters: ["json"],
    });
    const configuredRawPrefix = lintContent("{{* it.payload | json }}", {
        unsafeRawFilters: ["json"],
    });

    assert.deepStrictEqual(ruleIds(raw), ["no-unsafe-raw-json"]);
    assert.deepStrictEqual(ruleIds(rawPrefix), ["no-unsafe-raw-json"]);
    assert.deepStrictEqual(ruleIds(configured), ["no-unsafe-raw-json"]);
    assert.deepStrictEqual(ruleIds(safeFirst), ["no-unsafe-raw-json"]);
    assert.deepStrictEqual(ruleIds(configuredRawPrefix), ["no-unsafe-raw-json"]);
    assert.match(raw.diagnostics[0].message, /<\/script>/u);
});

test("finds unsafe JSON calls inside template-literal expressions", () => {
    const dynamic = lintContent("{{ `${JSON.stringify(it.payload)}` | safe }}");
    const prefixed = lintContent("{{ `prefix ${JSON.stringify(it.payload)}` | safe }}");
    const staticText = lintContent("{{ `JSON.stringify(it.payload)` | safe }}");

    assert.deepStrictEqual(ruleIds(dynamic), ["no-unsafe-raw-json"]);
    assert.deepStrictEqual(ruleIds(prefixed), ["no-unsafe-raw-json"]);
    assert.strictEqual(diagnosticsFor(staticText, "no-unsafe-raw-json").length, 0);
});

test("does not inspect JSON-looking text inside string literals", () => {
    for (const input of [
        '{{ "JSON.stringify(value)" | safe }}',
        "{{* /JSON.stringify(x)/.source }}",
    ]) {
        const result = lintContent(input);
        assert.strictEqual(diagnosticsFor(result, "no-unsafe-raw-json").length, 0, input);
    }
});

test("optional null-output protection is opt-in and fixable", () => {
    const input = "{{ it.user?.title }}";
    const defaultResult = lintContent(input);
    const guardedResult = lintContent(input, { noImplicitNullOutput: true });

    assert.strictEqual(defaultResult.content, input);
    assert.strictEqual(diagnosticsFor(defaultResult, "no-implicit-null-output").length, 0);
    assert.strictEqual(guardedResult.content, '{{ it.user?.title ?? "" }}');
    assert.deepStrictEqual(ruleIds(guardedResult), ["no-implicit-null-output"]);

    const bracket = lintContent('{{ it.user?.["title"] }}', { noImplicitNullOutput: true });
    assert.strictEqual(bracket.content, '{{ it.user?.["title"] ?? "" }}');

    const questionText = lintContent('{{ it["?."] }}', { noImplicitNullOutput: true });
    assert.strictEqual(questionText.content, '{{ it["?."] }}');
    assert.strictEqual(diagnosticsFor(questionText, "no-implicit-null-output").length, 0);

    for (const filter of ["safe", "e"]) {
        const filtered = lintContent(`{{ it.user?.title | ${filter} }}`, {
            noImplicitNullOutput: true,
        });
        assert.strictEqual(filtered.content, `{{ it.user?.title ?? "" | ${filter} }}`);
    }

    const asyncEscaped = lintContent("{{ it.user?.title | async e }}", {
        async: true,
        noImplicitNullOutput: true,
    });
    assert.strictEqual(asyncEscaped.content, '{{ it.user?.title ?? "" | async e }}');
});

test("reports malformed filter segments and bitwise assignments", () => {
    const malformed = lintContent("{{ it.value | 1 }}", { compile: false });
    const mutation = lintContent("{{ it.flags |= 1 }}", { compile: false });
    const trailingName = lintContent("{{ it.value | safe typo }}", {
        compile: false,
        forbidSafe: true,
    });
    const trailingCall = lintContent("{{ it.value | format() garbage }}", { compile: false });
    const validNestedCall = lintContent('{{ it.value | format(call("text )", nested(1))) }}', {
        compile: false,
    });

    assert.deepStrictEqual(ruleIds(malformed), ["valid-filter"]);
    assert.deepStrictEqual(ruleIds(mutation), ["no-output-assignment"]);
    assert.deepStrictEqual(ruleIds(trailingName), ["valid-filter"]);
    assert.deepStrictEqual(ruleIds(trailingCall), ["valid-filter"]);
    assert.deepStrictEqual(validNestedCall.diagnostics, []);
});

test("does not apply unsafe serializer policy to an invalid filter-name prefix", () => {
    const result = lintContent("{{ it.value | json typo | safe }}", {
        compile: false,
        unsafeRawFilters: ["json"],
    });
    assert.deepStrictEqual(ruleIds(result), ["valid-filter"]);
});

test("project policy can forbid execution tags and safe filters", () => {
    const result = lintContent("{{! const value = 1; }}{{ it.html | safe }}", {
        forbidExecute: true,
        forbidSafe: true,
    });

    assert.deepStrictEqual(ruleIds(result), ["no-execute-tag", "no-safe-filter"]);
});

test("semantic diagnostics expose stable source locations", () => {
    const result = lintContent('first\nsecond {{ it.value || "fallback" }}');
    const finding = result.diagnostics[0];

    assert.strictEqual(finding.ruleId, "no-unparenthesized-logical-or");
    assert.deepStrictEqual({ line: finding.line, column: finding.column }, { line: 2, column: 20 });
    assert.strictEqual(finding.index, 25);
    assert.strictEqual(finding.severity, "error");
});

test("all diagnostics stay anchored to the original input after earlier formatting", () => {
    const input = "{{x}}\n{{ it.a = 1 }}";
    const result = lintContent(input);
    const assignment = diagnosticsFor(result, "no-output-assignment")[0];

    assert.strictEqual(result.content, "{{ x }}\n{{ it.a = 1 }}");
    assert.deepStrictEqual(
        { index: assignment.index, line: assignment.line, column: assignment.column },
        { index: 9, line: 2, column: 4 },
    );
});

test("diagnostics are returned in source order", () => {
    const result = lintContent('{{ it.a = 1 }}\n{{ it.b || "x" }}');
    assert.deepStrictEqual(ruleIds(result), [
        "no-output-assignment",
        "no-unparenthesized-logical-or",
    ]);
    assert.ok(result.diagnostics[0].index < result.diagnostics[1].index);
});

test("a second pass is clean after all safe fixes", () => {
    const first = lintContent('{{ it.value || "x" }} {{# elseif(it.ok) }}', { compile: false });
    const second = lintContent(first.content, { compile: false });

    assert.strictEqual(first.changed, true);
    assert.strictEqual(second.changed, false);
    assert.strictEqual(
        second.diagnostics.some(({ fixable }) => fixable),
        false,
    );
});

test("null-output fixes preserve replacement-pattern text in expressions", () => {
    // `$'`, `$&`, and friends are meaningful in a String.replace replacement
    // string; the fixer must treat the expression as literal text.
    const result = lintContent('{{ it?.map["$\'"] }}', { noImplicitNullOutput: true });
    assert.strictEqual(result.content, '{{ it?.map["$\'"] ?? "" }}');
    assert.deepStrictEqual(ruleIds(result), ["no-implicit-null-output"]);

    const ampersand = lintContent('{{ it?.map["$&"] }}', { noImplicitNullOutput: true });
    assert.strictEqual(ampersand.content, '{{ it?.map["$&"] ?? "" }}');
});

test("ambiguous tags are reported even when engine compilation is disabled", () => {
    for (const input of ["{{/if}}/.test(x)}}", "{{ /foo}}/ }}"]) {
        const result = lintContent(input, { compile: false });
        assert.strictEqual(result.changed, false);
        assert.strictEqual(result.content, input);
        assert.deepStrictEqual(ruleIds(result), ["valid-squirrelly-syntax"]);
        assert.match(result.diagnostics[0].message, /ambiguous/iu);
    }
});
