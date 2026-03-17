# FaultyAI (AntiCopilot)

FaultyAI is a VS Code extension that intentionally suggests **buggy Java code** in a Copilot-like ghost text style.  
It is designed for debugging practice and learning by fixing incorrect suggestions.

## What It Does

- Watches what you type in Java files.
- Matches your current line against regex-based patterns.
- Shows inline ghost suggestions (single-line or multi-line).
- Lets you accept the current suggestion with `Tab` (`faultyai.acceptSuggestion`).
- Shows full suggestion on hover for the active suggestion line.

This extension does not call an external AI service. Suggestions are pattern-driven from local source code.

## Quick Start (Use the Extension)

1. Open this project in VS Code.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Compile TypeScript:
   ```bash
   npm run compile
   ```
4. Press `F5` (Run Extension) to open an Extension Development Host window.
5. In the new window, open/create a `.java` file and type trigger patterns such as:
   - `while`
   - `Scanner s`
   - `int[] numbers`
6. When ghost text appears, press `Tab` to accept.

## Required VS Code Setting

You must disable auto-closing brackets in VS Code, otherwise bracket auto-insertion conflicts with this extension's suggestion/accept flow. ( insert image ) 

Without this, suggestions may render or apply incorrectly.

## Commands and Keybindings

- Command: `faultyai.acceptSuggestion`
- Title: `FaultyAI: Accept Suggestion`
- Default keybinding: `Tab` (when editor has focus)

## Project Basics

- Entry point: `extension.ts`
- Suggestion engine: `src/SuggestionController.ts`
- Pattern definitions: `src/patterns.ts`
- Compiled output: `out/`

`package.json` points VS Code to `./out/extension.js`, so you must compile before running/publishing.

## Development Scripts

- `npm run compile` - compile TypeScript to `out/`
- `npm run watch` - compile in watch mode
- `npm run lint` - run ESLint
- `npm run test` - run extension test command
- `npm run vscode:prepublish` - compile before packaging/publish

## How Suggestions Work (Basic Flow)

1. A text change event fires.
2. The current line is checked against patterns from `src/patterns.ts`.
3. If matched, a suggestion preview is rendered as decoration.
4. Pressing `Tab` applies suggestion text into the document.
5. For multi-line inserts, the controller can add temporary preview spacing and then clean it up.

If a suggestion is deleted/rejected on a line, that specific line+pattern can be suppressed to reduce immediate re-suggestion noise.

## Editing or Adding Patterns

Patterns live in `src/patterns.ts`:

- `generic`: direct regex-to-suggestion mappings
- `variableDependent`: regex that captures values and builds suggestions dynamically

Each pattern entry defines:

- `trigger: RegExp`
- `suggestion` or `builder(...)`

After changes:

```bash
npm run compile
```

Then re-run Extension Host (`F5`) and test in a Java file.

## Requirements

- VS Code `^1.100.0`
- Node.js/npm environment for local development
- Auto-closing brackets disabled in VS Code (`editor.autoClosingBrackets = never`, including Java override)

## Troubleshooting

- Too many changed files in GitHub Desktop:
  - Ensure `.gitignore` includes `node_modules/`, `.vscode-test/`, and `out/`.
- GitHub Desktop lock error (`index.lock`):
  - Remove stale `.git/index.lock` after confirming no Git process is running.
- Extension changes not showing:
  - Re-run `npm run compile`.
  - Restart Extension Development Host window.

## Disclaimer

FaultyAI intentionally suggests incorrect code. Use it for practice and experimentation, not production coding.
