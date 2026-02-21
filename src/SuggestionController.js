const vscode = require("vscode");
const { createPatterns } = require("./patterns");

class SuggestionController {
  constructor() {
    this.greyDecoration = vscode.window.createTextEditorDecorationType({
      after: {
        color: "#888888",
        fontStyle: "italic",
      },
    });

    this.patterns = createPatterns();

    this.pendingSuggestion = null;
    this.acceptedLines = new Set();
    this.isAccepting = false;
    this.isAdjustingPreviewSpace = false;
    this.suggestionRequestId = 0;
    this.superpressedPatterns = new Map(); // Map: lineNumber -> Set of pattern keys
    this.previewSpacer = null; // { anchorLine: number, count: number }
  }

  removeLeadingTokens(text, tokens) {
    const sorted = [...tokens].sort((a, b) => b.length - a.length);
    for (const t of sorted) {
      if (t && text.startsWith(t)) return text.slice(t.length);
    }
    return text;
  }

  getIndentUnit(editor) {
    const insertSpaces = editor.options.insertSpaces !== false;
    const tabSize = Number(editor.options.tabSize) || 2;
    return insertSpaces ? " ".repeat(tabSize) : "\t";
  }

  buildIndentedSuggestionLines(editor, lineNumber, lines) {
    if (!Array.isArray(lines) || lines.length === 0) return [];

    const baseIndent = editor.document.lineAt(lineNumber).text.match(/^\s*/)[0];
    const indentUnit = this.getIndentUnit(editor);
    const result = [];
    let blockDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const rawLine = String(lines[i] ?? "");

      if (i === 0) {
        result.push(rawLine);
        if (/\{\s*$/.test(rawLine.trim())) {
          blockDepth = 1;
        }
        continue;
      }

      const trimmedLine = rawLine.trimStart();
      if (trimmedLine.length === 0) {
        result.push(baseIndent + indentUnit.repeat(blockDepth));
        continue;
      }

      if (/^[}\])]/.test(trimmedLine)) {
        blockDepth = Math.max(0, blockDepth - 1);
      }

      result.push(baseIndent + indentUnit.repeat(blockDepth) + trimmedLine);

      if (/\{\s*$/.test(trimmedLine)) {
        blockDepth += 1;
      }
    }

    return result;
  }

  renderDecorationWhitespace(editor, line) {
    const tabSize = Number(editor.options.tabSize) || 2;
    return line.replace(/^[ \t]+/, (leading) =>
      leading.replace(/\t/g, " ".repeat(tabSize)).replace(/ /g, "\u00A0"),
    );
  }

  countAvailableEmptyLines(doc, lineNumber) {
    let availableLines = 0;
    for (let i = lineNumber + 1; i < doc.lineCount; i++) {
      const line = doc.lineAt(i);
      if (line.isEmptyOrWhitespace) {
        availableLines++;
      } else {
        break;
      }
    }
    return availableLines;
  }

  async clearPreviewSpace(editor) {
    if (!editor || !this.previewSpacer) return;

    const { anchorLine, count } = this.previewSpacer;
    if (count <= 0) {
      this.previewSpacer = null;
      return;
    }

    const doc = editor.document;
    if (anchorLine >= doc.lineCount) {
      this.previewSpacer = null;
      return;
    }

    const endLine = Math.min(anchorLine + count, doc.lineCount - 1);
    const deleteRange = new vscode.Range(
      new vscode.Position(anchorLine, 0),
      new vscode.Position(endLine, 0),
    );

    this.isAdjustingPreviewSpace = true;
    try {
      await editor.edit((editBuilder) => {
        editBuilder.delete(deleteRange);
      });
    } catch (error) {
      console.error("Error clearing preview space:", error);
    } finally {
      this.isAdjustingPreviewSpace = false;
      this.previewSpacer = null;
    }
  }

  async ensurePreviewSpace(editor, lineNumber, requiredExtraLines) {
    if (!editor || requiredExtraLines <= 0) return;

    const anchorLine = lineNumber + 1;
    if (this.previewSpacer && this.previewSpacer.anchorLine !== anchorLine) {
      await this.clearPreviewSpace(editor);
    }

    const doc = editor.document;
    if (anchorLine > doc.lineCount) return;

    const availableLines = this.countAvailableEmptyLines(doc, lineNumber);
    const needed = requiredExtraLines - availableLines;
    if (needed <= 0) return;

    const insertPosition = new vscode.Position(anchorLine, 0);
    const spacerText = "\n".repeat(needed);

    this.isAdjustingPreviewSpace = true;
    try {
      await editor.edit((editBuilder) => {
        editBuilder.insert(insertPosition, spacerText);
      });

      if (this.previewSpacer && this.previewSpacer.anchorLine === anchorLine) {
        this.previewSpacer.count += needed;
      } else {
        this.previewSpacer = { anchorLine, count: needed };
      }
    } catch (error) {
      console.error("Error creating preview space:", error);
    } finally {
      this.isAdjustingPreviewSpace = false;
    }
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

  async showSuggestion(
    editor,
    lineNumber,
    suggestionLines,
    patternKey = null,
    requestId = null,
  ) {
    const doc = editor.document;
    const decorations = [];

    // Normalize suggestion to array
    const lines = Array.isArray(suggestionLines)
      ? suggestionLines
      : [suggestionLines];
    const indentedLines = this.buildIndentedSuggestionLines(
      editor,
      lineNumber,
      lines,
    );
    const displayLines = indentedLines.map((line) =>
      this.renderDecorationWhitespace(editor, line),
    );

    if (lines.length > 1) {
      await this.ensurePreviewSpace(editor, lineNumber, lines.length - 1);
    }

    // Ignore stale async renders.
    if (requestId !== null && requestId !== this.suggestionRequestId) {
      return;
    }

    // Determine display mode
    const needsMultiLine = lines.length > 1;
    const hasEnoughSpace =
      this.countAvailableEmptyLines(doc, lineNumber) >= lines.length - 1;
    const useSingleLine = needsMultiLine ? !hasEnoughSpace : false;

    if (useSingleLine) {
      // Single-line mode: combine all text
      const currentLine = doc.lineAt(lineNumber);
      const range = new vscode.Range(
        currentLine.range.start,
        currentLine.range.end,
      );
      const combinedText = displayLines.join(" ");

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
      for (let i = 0; i < displayLines.length; i++) {
        const targetLine = lineNumber + i;
        if (targetLine >= doc.lineCount) break;

        const line = doc.lineAt(targetLine);
        const range = new vscode.Range(line.range.start, line.range.end);

        decorations.push({
          range,
          renderOptions: {
            after: {
              contentText: displayLines[i],
            },
          },
        });
      }
    }

    editor.setDecorations(this.greyDecoration, decorations);

    // Store pending suggestion
    this.pendingSuggestion = {
      line: lineNumber,
      text: indentedLines.join("\n"),
      lines: lines,
      displayMode: useSingleLine ? "single" : "multi",
      patternKey,
    };
  }

  removeSuggestion(editor) {
    this.suggestionRequestId += 1;
    if (editor) {
      editor.setDecorations(this.greyDecoration, []);
      void this.clearPreviewSpace(editor);
    }
    this.pendingSuggestion = null;
  }

  async acceptSuggestion(editor) {
    if (!this.pendingSuggestion || this.isAccepting) return;

    this.isAccepting = true;
    const { line: lineNumber, lines } = this.pendingSuggestion;

    try {
      await this.clearPreviewSpace(editor);

      const currentLine = editor.document.lineAt(lineNumber);
      const indentedLines = this.buildIndentedSuggestionLines(
        editor,
        lineNumber,
        lines,
      );

      // Build the full text to insert
      let fullText = currentLine.text;
      for (let i = 0; i < indentedLines.length; i++) {
        const suggestionLine = indentedLines[i];
        if (i === 0) {
          // First line: append to current line
          fullText += suggestionLine;
        } else {
          // Subsequent lines are already fully indented
          fullText += "\n" + suggestionLine;
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
      if (lines.length > 1) {
        setTimeout(async () => {
          try {
            // Format only the inserted range for multiline suggestions
            const startPos = new vscode.Position(lineNumber, 0);
            const endPos = new vscode.Position(
              lastLineNumber,
              editor.document.lineAt(lastLineNumber).text.length,
            );
            editor.selection = new vscode.Selection(startPos, endPos);
            await vscode.commands.executeCommand(
              "editor.action.formatSelection",
            );

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
      }
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
    if (!editor || this.isAccepting || this.isAdjustingPreviewSpace) return;

    const document = editor.document;
    let pastLineNumber = 0;

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
        // match.suggestion - from the front if it matches with editor.current line
        // Scanner s = new Scanner();

        //<<<<=== Always use this for ref to understand =>>>>>>>>
        // currentLineText> Scanner s = new
        // res " "= new ", because its the remaining part after removing the matched part from current line text
        // resFinal = suggestion after removing the res part from the suggestion text
        const currentLineText = lineText.trimStart();

        // Get the actual matched text from the regex
        const actualMatch = match.regex.exec(currentLineText);
        const matchedText = actualMatch ? actualMatch[0] : "";

        let res;
        let resFinal;

        if (match.suggestion.length > 1) {
          // Multiline: process first line only, keep rest as-is
          res = this.removeLeadingTokens(currentLineText, [matchedText]);

          const firstLine = match.suggestion[0];
          const firstLineProcessed = this.removeLeadingTokens(firstLine, [res]);

          // Combine: processed first line + rest of the lines unchanged
          resFinal = [firstLineProcessed, ...match.suggestion.slice(1)];

          console.log("Res = " + res + "ResFinal = " + resFinal);

          const requestId = ++this.suggestionRequestId;
          void this.showSuggestion(
            editor,
            lineNumber,
            resFinal,
            match.key,
            requestId,
          );
          pastLineNumber += 1;
        } else {
          // Single line: just process the string
          res = this.removeLeadingTokens(currentLineText, [matchedText]);
          resFinal = this.removeLeadingTokens(match.suggestion.toString(), [
            res,
          ]);

          console.log("Res = " + res + "ResFinal = " + resFinal);

          const requestId = ++this.suggestionRequestId;
          void this.showSuggestion(
            editor,
            lineNumber,
            [resFinal],
            match.key,
            requestId,
          );
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

module.exports = { SuggestionController };
