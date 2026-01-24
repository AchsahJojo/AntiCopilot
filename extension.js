/*
// keep track and modofiy the replacemnt code , so for loops cuz it does not have much variation ; 
// nail down for loops so that users can contiue to write code and the suggested code should be altered to match the user code
*/
const vscode = require("vscode");

class SuggestionController {
  constructor() {
    this.greyDecoration = vscode.window.createTextEditorDecorationType({
      after: {
        color: "#888888",
        fontStyle: "italic",
      },
    });

    this.patterns = {
      // Regex-driven so users can match richer shapes than simple keywords.
      variableDependent: [
        {
          trigger: /\bScanner\s+(\w+)\b/,
          builder: ({}) => [` = new Scanner(System.in);`],
        },
        { trigger: /\bint\s+(\w+)\b/, builder: ({}) => [`= sc.next();`] },
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

    this.pendingSuggestion = null;
    this.acceptedLines = new Set();
    this.isAccepting = false;
    this.superpressedPatterns = new Map(); // Map: lineNumber -> Set of pattern keys
  }

  findTriggerMatch(lineText, lineNumber) {
    // Check generic patterns first (regex-driven)
    for (const entry of this.patterns.generic) {
      const match = entry.trigger.exec(lineText);
      if (match) {
        const patternKey = entry.trigger.toString();

        // Check if this pattern is suppressed for this specific line
        if (lineNumber !== undefined) {
          const suppressedForLine = this.superpressedPatterns.get(lineNumber);
          if (suppressedForLine && suppressedForLine.has(patternKey)) {
            return null; // Skip suppressed patterns
          }
        }

        const suggestion =
          typeof entry.suggestion === "function"
            ? entry.suggestion({ match })
            : entry.suggestion;
        return {
          type: "generic",
          key: patternKey,
          regex: entry.trigger,
          suggestion,
        };
      }
    }

    // Check variable-dependent patterns
    for (const entry of this.patterns.variableDependent) {
      const match = entry.trigger.exec(lineText);
      if (match) {
        const patternKey = entry.trigger.toString();

        // Check if this pattern is suppressed for this specific line
        if (lineNumber !== undefined) {
          const suppressedForLine = this.superpressedPatterns.get(lineNumber);
          if (suppressedForLine && suppressedForLine.has(patternKey)) {
            return null; // Skip suppressed patterns
          }
        }

        const variableName = match[1];
        return {
          type: "variableDependent",
          key: patternKey,
          regex: entry.trigger,
          variableName,
          suggestion: entry.builder({ variableName }),
        };
      }
    }

    return null;
  }

  async showSuggestion(editor, lineNumber, suggestionLines) {
    const doc = editor.document;
    const decorations = [];

    // Normalize suggestion to array
    const lines = Array.isArray(suggestionLines)
      ? suggestionLines
      : [suggestionLines];

    // Calculate available space below current line
    let availableLines = 0;
    for (let i = lineNumber + 1; i < doc.lineCount; i++) {
      const line = doc.lineAt(i);
      if (line.isEmptyOrWhitespace) {
        availableLines++;
      } else {
        break;
      }
    }

    // Determine display mode
    const needsMultiLine = lines.length > 1;
    const hasEnoughSpace = availableLines >= lines.length - 1;
    const useSingleLine = needsMultiLine && !hasEnoughSpace;

    if (useSingleLine) {
      // Single-line mode: combine all text
      const currentLine = doc.lineAt(lineNumber);
      const range = new vscode.Range(
        currentLine.range.start,
        currentLine.range.end,
      );
      const combinedText = lines.join(" ");

      decorations.push({
        range,
        renderOptions: {
          after: {
            contentText: combinedText,
          },
        },
      });
    } else {
      // Multi-line mode: show each line separately
      for (let i = 0; i < lines.length; i++) {
        const targetLine = lineNumber + i;
        if (targetLine >= doc.lineCount) break;

        const line = doc.lineAt(targetLine);
        const range = new vscode.Range(line.range.start, line.range.end);

        decorations.push({
          range,
          renderOptions: {
            after: {
              contentText: lines[i],
            },
          },
        });
      }
    }

    editor.setDecorations(this.greyDecoration, decorations);

    // Store pending suggestion
    this.pendingSuggestion = {
      line: lineNumber,
      text: lines.join("\n"),
      lines: lines,
      displayMode: useSingleLine ? "single" : "multi",
      patternKey: null, // Will be set when showing suggestion
    };
  }

  removeSuggestion(editor) {
    if (editor) {
      editor.setDecorations(this.greyDecoration, []);
    }
    this.pendingSuggestion = null;
  }

  async acceptSuggestion(editor) {
    if (!this.pendingSuggestion || this.isAccepting) return;

    this.isAccepting = true;
    const { line: lineNumber, lines } = this.pendingSuggestion;

    try {
      const currentLine = editor.document.lineAt(lineNumber);
      const currentIndent = currentLine.text.match(/^\s*/)[0];

      // Build the full text to insert
      let fullText = currentLine.text;
      for (let i = 0; i < lines.length; i++) {
        const suggestionLine = lines[i];
        if (i === 0) {
          // First line: append to current line
          fullText += suggestionLine;
        } else {
          // Subsequent lines: add newline and preserve indentation
          fullText += "\n" + currentIndent + suggestionLine;
        }
      }

      await editor.edit((editBuilder) => {
        const range = new vscode.Range(
          currentLine.range.start,
          currentLine.range.end,
        );
        editBuilder.replace(range, fullText);
      });

      // Mark line as accepted
      this.acceptedLines.add(lineNumber);

      // Clear the suggestion immediately
      this.removeSuggestion(editor);

      // Move cursor to end of inserted text
      const insertedLines = lines.length;
      const lastLineNumber = lineNumber + insertedLines - 1;
      const lastLine = editor.document.lineAt(lastLineNumber);
      const endPosition = new vscode.Position(
        lastLineNumber,
        lastLine.text.length,
      );
      editor.selection = new vscode.Selection(endPosition, endPosition);

      // Format after a brief delay to ensure edit is complete
      setTimeout(async () => {
        try {
          // Format only the inserted range
          const startPos = new vscode.Position(lineNumber, 0);
          const endPos = new vscode.Position(
            lastLineNumber,
            editor.document.lineAt(lastLineNumber).text.length,
          );
          editor.selection = new vscode.Selection(startPos, endPos);
          await vscode.commands.executeCommand("editor.action.formatSelection");

          // Restore cursor position at end
          const finalLine = editor.document.lineAt(lastLineNumber);
          const finalPos = new vscode.Position(
            lastLineNumber,
            finalLine.text.length,
          );
          editor.selection = new vscode.Selection(finalPos, finalPos);
        } catch (error) {
          console.error("Error formatting:", error);
        }
      }, 50);
    } catch (error) {
      console.error("Error accepting suggestion:", error);
    } finally {
      this.isAccepting = false;
    }
  }

  // Helper to find pattern match given line text
  findPattern(lineText) {
    for (const category of Object.values(this.patterns)) {
      for (const entry of category) {
        const match = entry.trigger.exec(lineText);
        if (match) {
          return entry;
        }
      }
    }
    return null;
  }

  handleTextChange(event) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || this.isAccepting) return;

    const document = editor.document;

    event.contentChanges.forEach((change) => {
      const lineNumber = change.range.start.line;
      const line = document.lineAt(lineNumber);
      const lineText = line.text;

      // Handle deletion
      /*
      Problem: When you delete a code suggestion and then retype the same code, 
      the autocomplete suggestion pops up again, which is annoying if you deliberately 
      rejected it.
      Solution:Create a feature that remembers when you've deleted a suggestion in a 
      specific area of your code. Once you delete it, the system won't show that same 
      suggestion again for those lines, so you can write your code without the ghost text 
      reappearing.
      */

      if (change.text === "" && change.rangeLength > 0) {
        // If there was a pending suggestion when deletion happened, suppress it
        if (
          this.pendingSuggestion &&
          this.pendingSuggestion.line === lineNumber
        ) {
          // Suppress the pattern that was being suggested for this line
          const patternKey = this.pendingSuggestion.patternKey;
          if (patternKey) {
            // Store line+pattern combination
            if (!this.superpressedPatterns.has(lineNumber)) {
              this.superpressedPatterns.set(lineNumber, new Set());
            }
            this.superpressedPatterns.get(lineNumber).add(patternKey);
            this.removeSuggestion(editor);
            return;
          }
        }

        this.removeSuggestion(editor);
        this.acceptedLines.delete(lineNumber);

        if (lineText.trim() === "") {
          this.acceptedLines.delete(lineNumber);
        }
        return;
      }

      // If line was previously accepted, check if it still matches
      if (this.acceptedLines.has(lineNumber)) {
        const match = this.findTriggerMatch(lineText, lineNumber);
        if (!match) {
          this.acceptedLines.delete(lineNumber);
        } else {
          return; // Still matches, don't re-suggest
        }
      }

      //Check for new pattern matches
      const match = this.findTriggerMatch(lineText, lineNumber);

      if (match) {
        // Remove old suggestion if exists
        if (this.pendingSuggestion) {
          this.removeSuggestion(editor);
        }

        // Show new suggestion
        this.showSuggestion(editor, lineNumber, match.suggestion);

        // Store pattern key for suppression tracking
        if (this.pendingSuggestion) {
          this.pendingSuggestion.patternKey = match.key;
        }

        // Show notification
        const varInfo =
          match.type === "variableDependent"
            ? ` with variable "${match.variableName}"`
            : "";
        vscode.window.showInformationMessage(
          `FaultyAI suggestion for "${match.key}"${varInfo}`,
        );
      } else if (
        this.pendingSuggestion &&
        this.pendingSuggestion.line === lineNumber
      ) {
        // Line no longer matches, remove suggestion
        this.removeSuggestion(editor);
      }
    });
  }
}

let controller;

function activate(context) {
  console.log("FaultyAI extension activated!");

  controller = new SuggestionController();

  // Hover provider for showing full suggestion
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { scheme: "file", language: "java" },
      {
        provideHover(document, position) {
          if (!controller.pendingSuggestion) return;

          const lineNumber = position.line;
          if (lineNumber === controller.pendingSuggestion.line) {
            return new vscode.Hover(
              `**FaultyAI Suggestion** (Press Tab to accept)\n\`\`\`java\n${controller.pendingSuggestion.text}\n\`\`\``,
            );
          }
        },
      },
    ),
  );

  // Text change listener
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) =>
      controller.handleTextChange(event),
    ),
  );

  // Editor focus change
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((newEditor) => {
      if (!newEditor) {
        controller.removeSuggestion(vscode.window.activeTextEditor);
      }
    }),
  );

  // Accept suggestion command
  context.subscriptions.push(
    vscode.commands.registerCommand("faultyai.acceptSuggestion", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        controller.acceptSuggestion(editor);
      }
    }),
  );
}

function deactivate() {
  if (controller) {
    controller.removeSuggestion(vscode.window.activeTextEditor);
  }
}

module.exports = {
  activate,
  deactivate,
};
