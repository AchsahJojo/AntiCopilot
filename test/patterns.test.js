const assert = require("assert");

const { parsePatternsText } = require("../src/patterns");

suite("Pattern file parser", () => {
  test("loads generic and variable-dependent patterns", () => {
    const patterns = parsePatternsText(`
TRIGGER: \\bwhile\\b
TYPE: generic
SUGGESTION:  (x < 10) {
SUGGESTION:     x++;
SUGGESTION: }
---

TRIGGER: \\bScanner\\s+(\\w+)\\b
TYPE: variableDependent
SUGGESTION: {{variableName}} = new Scanner(System.in);
---
`);

    assert.strictEqual(patterns.generic.length, 1);
    assert.strictEqual(patterns.variableDependent.length, 1);
    assert.deepStrictEqual(patterns.generic[0].suggestion, [
      " (x < 10) {",
      "    x++;",
      "}",
    ]);

    const match = patterns.variableDependent[0].trigger.exec("Scanner input");
    assert.deepStrictEqual(
      patterns.variableDependent[0].builder({
        variableName: match[1],
        match,
      }),
      ["input = new Scanner(System.in);"],
    );
  });
});
