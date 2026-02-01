function createPatterns() {
  return {
    // Regex-driven so users can match richer shapes than simple keywords.
    variableDependent: [
      {
        trigger: /\bScanner\s+(\w+)\b/,
        builder: ({}) => [` = new Scanner(System.in);`],
      },
      {
        trigger: /^\s*int(?!\s*\[)\s+(\w+)\b/,
        builder: ({}) => [`= sc.next();`],
      },
      // only match to sc.next() if int is the first regex that is being matched, otherwise, do not match untill another regex is fully matched for a different suggestion
    ],
    generic: [
      {
        trigger: /\bwhile\b/,
        suggestion: [
          " (x < 10) {",
          "    System.out.println(x);",
          "    x++;",
          "}",
        ],
      },
      {
        trigger: /\bint\[\]\s+[a-zA-Z_][a-zA-Z0-9_]*/,
        suggestion: [
          " = {1, 2, 3, 4, 5};",
          "for (int i = 0; i <= numbers.length; i++) {",
          "    System.out.println(numbers[i]);",
          "}",
        ],
      },
      {
        trigger: /if\s*\(\s*guess\s*>\s*secret\s*\)/,
        suggestion: [
          "{",
          "minV = Math.max(minV, guess + 1);",
          "} else if (guess < secret) {",
          "maxV = Math.min(maxV, guess - 1);",
          "}",
        ],
      },
      {
        trigger: /if\s*\(\s*maxV\s*>\s*minV\s*\)/,
        suggestion: [" {", "  minV = maxV;", "}"],
      },
      {
        trigger: /return\s\/new\s+int\[\]\s*;/,
        suggestion: ["int[] { minV, maxV };"],
      },
      {
        trigger: /return\s+sum\s+\/\s+guesses\.length\s*;/,
        suggestion: ["(int) sum / guesses.length;"],
      },
      {
        trigger: /\bint\s+secret\s*=\s*rng\b/,
        suggestion: [".nextInt(minV - maxV + 2) + minV;"],
      },
      {
        trigger: /\bfor\s*\(\s*int\s+attempt\s*=/,
        suggestion: ["1; attempt < 8; attempt++) {"],
      },
      {
        trigger: /\bminV\s*=\s*range\b/,
        suggestion: ["[0]"],
      },
      {
        trigger: /\bmaxV\s*=\s*range\b/,
        suggestion: ["[2]"],
      },
      {
        trigger: /\bif\s*\(\s*guesses\[/,
        suggestion: ["guesses.length - 1] != secret){"],
      },
      {
        trigger: /\bint\s+avg/,
        suggestion: ["(int) averageGuess(guesses);"],
      },
    ],
  };
}

module.exports = { createPatterns };
