/**
 * Lints and fixes Squirrelly template syntax spacing.
 * @param {string} originalContent - The raw file content
 * @returns {{changed: boolean, content: string}}
 */
export function lintContent(originalContent) {
  let content = originalContent;

  // 1. Raw Output Tags: {{{ and }}}
  // Ensures exactly one space inside raw output interpolation blocks.
  content = content.replace(/\{\{\{[ \t]*/g, "{{{ ");
  content = content.replace(/[ \t]*\}\}\}/g, " }}}");

  // 2. Helper/Macro Tags: {{@, {{#, {{!
  // Matches `{{ @`, `{{#`, or `{{!` and collapses surrounding whitespace into exactly `{{# `.
  content = content.replace(/\{\{[ \t]*([@#!])[ \t]*/g, "{{$1 ");

  // 3. Closing block start tag: {{/
  // e.g. `{{ / extends }}` -> `{{/ extends `
  content = content.replace(/\{\{[ \t]*\/[ \t]*/g, "{{/ ");

  // 4. Base start tag: {{
  // Match {{ not followed by @, #, !, /, or {
  content = content.replace(/\{\{(?![@#!/{])[ \t]*/g, "{{ ");

  // 5. Self-closing tag end: /}}
  // Captures any spacing around the slash to ensure exactly ` /}}` with no space between / and }}
  content = content.replace(/[ \t]*\/[ \t]*\}\}/g, " /}}");

  // 6. Base end tag: }} (not preceded by / or })
  // We capture the character immediately before the optional whitespace mapping to }}
  content = content.replace(/([^/}\s])[ \t]*\}\}(?!\})/g, "$1 }}");

  return {
    changed: content !== originalContent,
    content,
  };
}
