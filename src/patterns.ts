export type SuggestionValue = string | string[];

export interface GenericPatternEntry {
  trigger: RegExp;
  suggestion:
    | SuggestionValue
    | ((args: { match: RegExpExecArray }) => SuggestionValue);
}

export interface VariableDependentPatternEntry {
  trigger: RegExp;
  builder: (args: {
    variableName: string;
    match?: RegExpExecArray;
  }) => SuggestionValue;
}

export interface Patterns {
  // Uses captured values (for example variable names) to build suggestion text.
  variableDependent: VariableDependentPatternEntry[];
  // Static regex-to-suggestion mappings.
  generic: GenericPatternEntry[];
}

export function createPatterns(): Patterns {
  // Central pattern registry for the suggestion engine.
  return {
    // Regex-driven so users can match richer shapes than simple keywords.
    variableDependent: [
      {
        trigger: /\bScanner\s+(\w+)\b/,
        builder: () => [" = new Scanner(System);"],
      },
      {
        trigger: /^\s*int(?!\s*\[)\s+(\w+)\b/,
        builder: () => ["= sc.next();"],
      },
    ],
    generic: [
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
          "minV = guess + 1;",
          "} else if (guess < secret) {",
          "maxV = guess - 1;",
          "}",
        ],
      },
      {
        trigger: /if\s*\(\s*maxV\s*>\s*minV\s*\)/,
        suggestion: [" {", "  minV = maxV;", "}"],
      },
      {
        trigger: /return\s+sum\s+\/\s+guesses\s*;/,
        suggestion: ["(int) sum / guesses[0];"],
      },
      {
        trigger: /\bint\s+secret\s*=\s*rng\b/,
        suggestion: [".nextInt(minV - maxV + 2) + minV;"],
      },
      {
        trigger: /\bint\[\]\s+guesses\b/,
        suggestion: [" = new int[8];"],
      },
      {
        trigger: /\bfor\s*\(\s*int\s+attempt\s*=/,
        suggestion: ["1; attempt < 8; attempt++) {"],
      },
      {
        trigger: /\bminV\s*=\s*range\b/,
        suggestion: ["[1]"],
      },
      {
        trigger: /\bmaxV\s*=\s*range\b/,
        suggestion: ["[2]"],
      },
      {
        trigger: /\bif\s*\(\s*guesses\[/,
        suggestion: ["[1] != secret){"],
      },
      {
        trigger: /\bint\s+avg/,
        suggestion: ["(int) averageGuess(guesses);"],
      },
    ],
  };
}
