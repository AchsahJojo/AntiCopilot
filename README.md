# AntiCopilot

_AntiCopilot_ is a Visual Studio Code extension designed to emulate GitHub Copilot, but instead of suggesting correct code, it intentionally generates code with errors. This helps students improve their debugging skills by forcing them to find and fix mistakes in AI-generated code.

## Features

- **Ghost Suggestions**: Handles single and multiple line code suggestions interchangeably.
- **Beginner Java Pattern Detection**: Detects common beginner Java patterns and replaces them with intentionally buggy code.
- **Real-time Cursor Tracking**: Implements ghost-style coding suggestions that follow your cursor position in real time.
- **Advanced Editor State Management**: Handles multi-line suggestions, variable naming conventions, and manages editor state for deletion, insertion, and other edge cases.
- **Activation Events & Reactive Behavior**: Utilizes VS Code activation events for responsive and object-oriented problem solving.
- **Code Change Notifications**: Notifies users when code changes occur, helping track and understand the impact of edits.

## Project Structure

The extension is intentionally small. Most behavior lives in these files:

| File | Purpose |
| --- | --- |
| `extension.js` | VS Code entry point. Creates the controller, registers hover support, watches pattern-file changes, listens for document changes, and registers the Tab accept command. |
| `src/SuggestionController.js` | Main suggestion engine. Handles formatting, ghost-text rendering, accepting suggestions, deletion/rejection behavior, comment-aware code extraction, and dynamic pattern matching. |
| `src/patterns.js` | Loads and parses the pattern file into generic and variable-dependent trigger entries. |
| `src/patterns.txt` | Default editable list of Java triggers and intentionally flawed suggestions. |
| `src/AutoClosingBracketsManager.js` | Temporarily disables VS Code auto-closing brackets for the workspace while the extension is active. |
| `package.json` | Extension manifest, activation events, command/keybinding registration, configuration, and npm scripts. |
| `test/patterns.test.js` | Unit coverage for the pattern-file parser. |

For local setup, see `GETTING_STARTED.txt`.

## How Suggestions Flow Through the Extension

1. VS Code activates the extension for Java files or on startup.
2. `extension.js` creates a `SuggestionController`, loads the configured pattern file, and registers listeners.
3. When the user types in a Java file, `handleTextChange` routes the change to the right area:
   - deletion and rejection handling
   - non-code edits such as indentation or newlines
   - dynamic pattern matching for real code typing
4. `getCodeOnlyLineText` strips Java comments before matching, so triggers inside comments are ignored.
5. `findTriggerMatch` checks generic patterns first, then variable-dependent patterns.
6. `buildCompletionLines` removes text the user already typed so the ghost suggestion only shows the missing portion.
7. `showSuggestion` renders gray ghost text with VS Code decorations. Multi-line suggestions may insert temporary blank spacer lines so the preview has room to display.
8. Pressing Tab runs `faultyai.acceptSuggestion`, inserts the pending suggestion, clears preview state, and formats accepted multi-line suggestions.
9. If the user deletes while a suggestion is visible, the matching pattern is suppressed for that line so the same rejected suggestion does not immediately reappear.

## `SuggestionController.js` Navigation

`src/SuggestionController.js` is grouped with section headers so new engineers can jump to the right concern:

- **Controller lifecycle and VS Code command state**: pattern reloads and Tab key context.
- **AntiCopilot suggestion formatting**: turns pattern suggestions into correctly indented completion text.
- **Preview rendering and cleanup**: draws ghost text, creates temporary preview space, and clears it.
- **Dynamic pattern matching and suggestion generation**: finds matching triggers and builds static or variable-dependent suggestions.
- **Suggestion acceptance**: commits the visible ghost text and formats accepted multi-line code.
- **Deletion and rejection handling**: remembers rejected line/pattern combinations.
- **Comment-aware code extraction**: removes Java comments while preserving strings and character literals.
- **Document change orchestration**: keeps the main text-change listener readable by delegating to the sections above.

## Installation and Use

1. Install dependencies with `npm install`.
2. Open the project in VS Code.
3. Press `F5` and choose **Run Extension** to open an Extension Development Host window.
4. In the Extension Development Host, create or open a `.java` file.
5. Start typing a trigger such as `Scanner s`, `while`, `for`, or one of the patterns from `src/patterns.txt`.
6. Press Tab while the gray suggestion is visible to accept it.

To verify that the extension is running, open the Command Palette and select **Developer: Show Running Extensions**. Look for the `faultyai` extension.

## Pattern File

FaultyAI loads suggestion patterns from `src/patterns.txt` by default. To use a different file, set `faultyai.patternsFile` in VS Code settings to an absolute path like `/Users/achsahjojo/Desktop/patterns.txt`, or to a path relative to the workspace.

Pattern blocks use this format:

```text
TRIGGER: \bScanner\s+(\w+)\b
TYPE: variableDependent
SUGGESTION:  = new Scanner(System.in);
---
```

Use `TYPE: generic` for fixed suggestions and `TYPE: variableDependent` when the trigger captures a variable name. Variable-dependent suggestions can include `{{variableName}}` or capture groups like `{{1}}`.

The extension watches the configured pattern file. When the file changes, `extension.js` reloads patterns and clears pending suggestions.

## Adding or Changing Suggestions

1. Edit `src/patterns.txt`, or point `faultyai.patternsFile` to another pattern file.
2. Add one pattern block per trigger.
3. Use one `SUGGESTION:` line for single-line suggestions and multiple `SUGGESTION:` lines for multi-line suggestions.
4. Use capture groups in the `TRIGGER:` regex when the suggestion needs dynamic values.
5. Run `npm run lint` after code changes. Pattern-file-only changes do not require linting, but the Extension Development Host should be reloaded if behavior looks stale.

Example variable-dependent pattern:

```text
TRIGGER: \bScanner\s+(\w+)\b
TYPE: variableDependent
SUGGESTION: {{variableName}} = new Scanner(System.in);
---
```

## Development Commands

```bash
npm install
npm run lint
npm test
```

`npm run lint` currently passes for the project. `npm test` runs lint first and then calls `vscode-test`; the repository currently needs a `.vscode-test` config file before that integration test command can complete.
