const vscode = require("vscode");
const { createPatterns } = require("./patterns");

const ACCEPTED_SUGGESTION_FORMAT_DELAY_MS = 50;

/**
 * Coordinates AntiCopilot/FaultyAI inline suggestions.
 *
 * Main responsibilities:
 * - Load and match trigger patterns.
 * - Format suggestion text so it lines up with the user's code.
 * - Render, clear, and accept gray ghost-text suggestions.
 * - Suppress suggestions the user rejected by deleting them.
 */
class SuggestionController {
  constructor() {
    // Gray italic ghost text rendered after matching source lines.
    this.greyDecoration = vscode.window.createTextEditorDecorationType({
      after: {
        color: "#888888",
        fontStyle: "italic",
      },
    });

    this.patterns = createPatterns();

    // Current visible suggestion, if any. Extension hover code reads this too.
    this.pendingSuggestion = null;

    // Lines that already accepted a suggestion should not immediately re-trigger.
    this.acceptedLines = new Set();

    // Guards for edits made by this controller so we do not react to ourselves.
    this.isAccepting = false;
    this.isAdjustingPreviewSpace = false;

    // Incremented before each render so stale async preview updates are ignored.
    this.suggestionRequestId = 0;

    // Map: lineNumber -> Set of pattern keys rejected on that line.
    this.suppressedPatterns = new Map();

    // Temporary blank lines inserted to make room for multi-line previews.
    this.previewSpacer = null; // { anchorLine: number, count: number }

    this.setSuggestionContext(false);
  }

  // ---------------------------------------------------------------------------
  // Controller lifecycle and VS Code command state
  // ---------------------------------------------------------------------------

  reloadPatterns() {
    this.patterns = createPatterns();
    this.acceptedLines.clear();
    this.suppressedPatterns.clear();
    this.removeSuggestion(vscode.window.activeTextEditor);
  }

  setSuggestionContext(hasSuggestion) {
    void vscode.commands.executeCommand(
      "setContext",
      "faultyai.hasSuggestion",
      Boolean(hasSuggestion),
    );
  }

  syncSuggestionContextForEditor(editor) {
    if (!editor || !this.pendingSuggestion) {
      this.setSuggestionContext(false);
      return;
    }

    const activeLine = editor.selection?.active.line;
    this.setSuggestionContext(activeLine === this.pendingSuggestion.line);
  }

  // ---------------------------------------------------------------------------
  // AntiCopilot suggestion formatting
  // ---------------------------------------------------------------------------

  /**
   * Converts a pattern suggestion into an array so formatting/rendering code can
   * treat single-line and multi-line suggestions the same way.
   */
  normalizeSuggestionLines(suggestion) {
    if (suggestion === undefined || suggestion === null) return [];
    if (Array.isArray(suggestion)) {
      return suggestion.map((line) => String(line ?? ""));
    }
    return [String(suggestion)];
  }

  /**
   * Removes the longest matching prefix from text.
   *
   * Used when the user has already typed part of the suggestion. For example,
   * if the user typed `Scanner s = new`, the preview only shows the remaining
   * ` Scanner(System.in);` portion instead of repeating the whole suggestion.
   */
  removeLeadingTokens(text, tokens) {
    const sorted = [...tokens].sort((a, b) => b.length - a.length);
    for (const token of sorted) {
      if (token && text.startsWith(token)) return text.slice(token.length);
    }
    return text;
  }

  /**
   * Builds the exact completion text still missing from the current source line.
   * Multi-line suggestions trim only the first line; later lines are kept whole.
   */
  buildCompletionLines(match, codeOnlyLineText) {
    const currentLineText = codeOnlyLineText.trimStart();
    const actualMatch = match.regex.exec(currentLineText);
    const matchedText = actualMatch ? actualMatch[0] : "";
    const typedRemainder = this.removeLeadingTokens(currentLineText, [
      matchedText,
    ]);
    const suggestionLines = this.normalizeSuggestionLines(match.suggestion);

    if (suggestionLines.length === 0) return [];

    const [firstLine, ...remainingLines] = suggestionLines;
    return [
      this.removeLeadingTokens(firstLine, [typedRemainder]),
      ...remainingLines,
    ];
  }

  getIndentUnit(editor) {
    const insertSpaces = editor.options.insertSpaces !== false;
    const tabSize = Number(editor.options.tabSize) || 2;
    return insertSpaces ? " ".repeat(tabSize) : "\t";
  }

  /**
   * Applies document indentation to suggestion lines before they are rendered or
   * inserted. The first line is a suffix for the current line; following lines
   * inherit the current line's indentation and adjust for braces.
   */
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

  /**
   * VS Code decoration text collapses normal leading spaces. Convert only the
   * leading indentation to non-breaking spaces so ghost text keeps its shape.
   */
  renderDecorationWhitespace(editor, line) {
    const tabSize = Number(editor.options.tabSize) || 2;
    return line.replace(/^[ \t]+/, (leading) =>
      leading.replace(/\t/g, " ".repeat(tabSize)).replace(/ /g, "\u00A0"),
    );
  }

  /**
   * After accepting a multi-line suggestion, ask VS Code to format just the
   * inserted range and then put the cursor back at the end of the insertion.
   */
  scheduleAcceptedSuggestionFormatting(editor, startLineNumber, endLineNumber) {
    setTimeout(async () => {
      try {
        const startPos = new vscode.Position(startLineNumber, 0);
        const endPos = new vscode.Position(
          endLineNumber,
          editor.document.lineAt(endLineNumber).text.length,
        );
        editor.selection = new vscode.Selection(startPos, endPos);
        await vscode.commands.executeCommand("editor.action.formatSelection");

        this.moveCursorToEndOfLine(editor, endLineNumber);
      } catch (error) {
        console.error("Error formatting:", error);
      }
    }, ACCEPTED_SUGGESTION_FORMAT_DELAY_MS);
  }

  // ---------------------------------------------------------------------------
  // Preview rendering and cleanup
  // ---------------------------------------------------------------------------

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

  /**
   * Removes temporary blank lines that were inserted only to display a multi-line
   * ghost preview. This keeps preview edits from becoming real user code.
   */
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

  /**
   * Multi-line ghost text can only be drawn on lines that exist. Insert blank
   * spacer lines when the document does not already have enough empty space.
   */
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

  /**
   * Renders a pending suggestion as gray ghost text and records enough metadata
   * for hover, Tab acceptance, and rejection suppression.
   */
  async showSuggestion(
    editor,
    lineNumber,
    suggestionLines,
    patternKey = null,
    requestId = null,
  ) {
    const lines = this.normalizeSuggestionLines(suggestionLines);
    if (lines.length === 0) return;

    const doc = editor.document;
    const decorations = [];
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

    // Ignore renders that were overtaken by a newer typing event.
    if (requestId !== null && requestId !== this.suggestionRequestId) {
      return;
    }

    const needsMultiLine = lines.length > 1;
    const hasEnoughSpace =
      this.countAvailableEmptyLines(doc, lineNumber) >= lines.length - 1;
    const useSingleLine = needsMultiLine ? !hasEnoughSpace : false;

    if (useSingleLine) {
      const currentLine = doc.lineAt(lineNumber);
      const range = new vscode.Range(
        currentLine.range.start,
        currentLine.range.end,
      );

      decorations.push({
        range,
        renderOptions: {
          after: {
            contentText: displayLines.join(" "),
          },
        },
      });
    } else {
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

    this.pendingSuggestion = {
      line: lineNumber,
      text: indentedLines.join("\n"),
      lines,
      displayMode: useSingleLine ? "single" : "multi",
      patternKey,
    };
    this.setSuggestionContext(true);
  }

  removeSuggestion(editor) {
    this.suggestionRequestId += 1;
    if (editor) {
      editor.setDecorations(this.greyDecoration, []);
      void this.clearPreviewSpace(editor);
    }
    this.pendingSuggestion = null;
    this.setSuggestionContext(false);
  }

  // ---------------------------------------------------------------------------
  // Dynamic pattern matching and suggestion generation
  // ---------------------------------------------------------------------------

  isPatternSuppressed(lineNumber, patternKey) {
    if (lineNumber === undefined) return false;
    const suppressedForLine = this.suppressedPatterns.get(lineNumber);
    return Boolean(suppressedForLine && suppressedForLine.has(patternKey));
  }

  /**
   * Finds the first pattern that matches the current code-only line.
   * Generic patterns return static suggestions; variable-dependent patterns
   * build suggestions from regex captures such as a variable name.
   */
  findTriggerMatch(lineText, lineNumber) {
    for (const entry of this.patterns.generic) {
      const match = entry.trigger.exec(lineText);
      if (match) {
        const patternKey = entry.trigger.toString();
        if (this.isPatternSuppressed(lineNumber, patternKey)) return null;

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

    for (const entry of this.patterns.variableDependent) {
      const match = entry.trigger.exec(lineText);
      if (match) {
        const patternKey = entry.trigger.toString();
        if (this.isPatternSuppressed(lineNumber, patternKey)) return null;

        const variableName = match[1];
        return {
          type: "variableDependent",
          key: patternKey,
          regex: entry.trigger,
          variableName,
          suggestion: entry.builder({ variableName, match }),
        };
      }
    }

    return null;
  }

  /**
   * Lower-level pattern finder kept for diagnostics/tests that only need the
   * pattern entry, not the normalized render payload used by findTriggerMatch.
   */
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

  showMatchNotification(match) {
    const varInfo =
      match.type === "variableDependent"
        ? ` with variable "${match.variableName}"`
        : "";
    vscode.window.showInformationMessage(
      `FaultyAI suggestion for "${match.key}"${varInfo}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Suggestion acceptance
  // ---------------------------------------------------------------------------

  buildAcceptedSuggestionText(currentLineText, indentedLines) {
    let fullText = currentLineText;
    for (let i = 0; i < indentedLines.length; i++) {
      const suggestionLine = indentedLines[i];
      fullText += i === 0 ? suggestionLine : `\n${suggestionLine}`;
    }
    return fullText;
  }

  moveCursorToEndOfLine(editor, lineNumber) {
    const line = editor.document.lineAt(lineNumber);
    const position = new vscode.Position(lineNumber, line.text.length);
    editor.selection = new vscode.Selection(position, position);
  }

  /**
   * Commits the currently visible ghost suggestion into the editor when the
   * caret is still on the suggestion line. Multi-line insertions are formatted
   * after the edit so the accepted code matches the document style.
   */
  async acceptSuggestion(editor) {
    if (!this.pendingSuggestion || this.isAccepting) return;
    if (editor.selection?.active.line !== this.pendingSuggestion.line) {
      this.setSuggestionContext(false);
      return;
    }

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
      const fullText = this.buildAcceptedSuggestionText(
        currentLine.text,
        indentedLines,
      );

      await editor.edit((editBuilder) => {
        const range = new vscode.Range(
          currentLine.range.start,
          currentLine.range.end,
        );
        editBuilder.replace(range, fullText);
      });

      this.acceptedLines.add(lineNumber);
      this.removeSuggestion(editor);

      const lastLineNumber = lineNumber + lines.length - 1;
      this.moveCursorToEndOfLine(editor, lastLineNumber);

      if (lines.length > 1) {
        this.scheduleAcceptedSuggestionFormatting(
          editor,
          lineNumber,
          lastLineNumber,
        );
      }
    } catch (error) {
      console.error("Error accepting suggestion:", error);
    } finally {
      this.isAccepting = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Deletion and rejection handling
  // ---------------------------------------------------------------------------

  suppressPatternForLine(lineNumber, patternKey) {
    if (!this.suppressedPatterns.has(lineNumber)) {
      this.suppressedPatterns.set(lineNumber, new Set());
    }
    this.suppressedPatterns.get(lineNumber).add(patternKey);
  }

  /**
   * Handles user deletions separately from normal typing. If the user deletes
   * while a suggestion is visible, treat that as a rejection and suppress the
   * same pattern on that line so it does not immediately reappear.
   */
  handleDeletionChange(editor, lineNumber) {
    if (this.pendingSuggestion && this.pendingSuggestion.line === lineNumber) {
      const patternKey = this.pendingSuggestion.patternKey;
      if (patternKey) {
        this.suppressPatternForLine(lineNumber, patternKey);
        this.removeSuggestion(editor);
        return;
      }
    }

    this.removeSuggestion(editor);
    this.acceptedLines.delete(lineNumber);
  }

  // ---------------------------------------------------------------------------
  // Comment-aware code extraction
  // ---------------------------------------------------------------------------

  /**
   * Determines whether a line starts inside a Java block comment. String and
   * character literals are tracked so comment markers inside quotes are ignored.
   */
  isInsideBlockCommentAtLineStart(document, targetLineNumber) {
    let inBlockComment = false;
    let inDoubleQuote = false;
    let inSingleQuote = false;
    let isEscaped = false;

    for (let lineNumber = 0; lineNumber < targetLineNumber; lineNumber++) {
      const text = document.lineAt(lineNumber).text;

      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = i + 1 < text.length ? text[i + 1] : "";

        if (inBlockComment) {
          if (ch === "*" && next === "/") {
            inBlockComment = false;
            i++;
          }
          continue;
        }

        if (inDoubleQuote) {
          if (isEscaped) {
            isEscaped = false;
            continue;
          }
          if (ch === "\\") {
            isEscaped = true;
            continue;
          }
          if (ch === '"') {
            inDoubleQuote = false;
          }
          continue;
        }

        if (inSingleQuote) {
          if (isEscaped) {
            isEscaped = false;
            continue;
          }
          if (ch === "\\") {
            isEscaped = true;
            continue;
          }
          if (ch === "'") {
            inSingleQuote = false;
          }
          continue;
        }

        if (ch === "/" && next === "*") {
          inBlockComment = true;
          i++;
          continue;
        }

        if (ch === "/" && next === "/") {
          break;
        }

        if (ch === '"') {
          inDoubleQuote = true;
          isEscaped = false;
          continue;
        }

        if (ch === "'") {
          inSingleQuote = true;
          isEscaped = false;
        }
      }
    }

    return inBlockComment;
  }

  /**
   * Returns only executable code from one line by removing Java comments while
   * preserving string and character literals.
   */
  stripCommentsFromLine(lineText, startsInsideBlockComment) {
    let inBlockComment = startsInsideBlockComment;
    let inDoubleQuote = false;
    let inSingleQuote = false;
    let isEscaped = false;
    let code = "";

    for (let i = 0; i < lineText.length; i++) {
      const ch = lineText[i];
      const next = i + 1 < lineText.length ? lineText[i + 1] : "";

      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          i++;
        }
        continue;
      }

      if (inDoubleQuote) {
        code += ch;
        if (isEscaped) {
          isEscaped = false;
          continue;
        }
        if (ch === "\\") {
          isEscaped = true;
          continue;
        }
        if (ch === '"') {
          inDoubleQuote = false;
        }
        continue;
      }

      if (inSingleQuote) {
        code += ch;
        if (isEscaped) {
          isEscaped = false;
          continue;
        }
        if (ch === "\\") {
          isEscaped = true;
          continue;
        }
        if (ch === "'") {
          inSingleQuote = false;
        }
        continue;
      }

      if (ch === "/" && next === "/") {
        break;
      }

      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i++;
        continue;
      }

      if (ch === '"') {
        inDoubleQuote = true;
        isEscaped = false;
        code += ch;
        continue;
      }

      if (ch === "'") {
        inSingleQuote = true;
        isEscaped = false;
        code += ch;
        continue;
      }

      code += ch;
    }

    return code;
  }

  getCodeOnlyLineText(document, lineNumber) {
    const lineText = document.lineAt(lineNumber).text;
    const startsInsideBlockComment = this.isInsideBlockCommentAtLineStart(
      document,
      lineNumber,
    );
    return this.stripCommentsFromLine(lineText, startsInsideBlockComment);
  }

  // ---------------------------------------------------------------------------
  // Document change orchestration
  // ---------------------------------------------------------------------------

  isCodeTypingChange(change) {
    if (!change || typeof change.text !== "string") return false;
    if (change.text.length === 0) return false;
    return /\S/.test(change.text);
  }

  handleNonCodeChange(editor, lineNumber) {
    if (this.pendingSuggestion && this.pendingSuggestion.line === lineNumber) {
      this.removeSuggestion(editor);
    }
  }

  /**
   * Once a line accepted a suggestion, keep it quiet while the line still
   * matches the same pattern. If the user changes the line so it no longer
   * matches, clear the accepted marker and allow future suggestions.
   */
  shouldSkipAcceptedLine(lineNumber, codeOnlyLineText) {
    if (!this.acceptedLines.has(lineNumber)) return false;

    const match = this.findTriggerMatch(codeOnlyLineText, lineNumber);
    if (!match) {
      this.acceptedLines.delete(lineNumber);
      return false;
    }

    return true;
  }

  handlePotentialSuggestion(editor, lineNumber, codeOnlyLineText) {
    const match = this.findTriggerMatch(codeOnlyLineText, lineNumber);

    if (!match) {
      if (this.pendingSuggestion && this.pendingSuggestion.line === lineNumber) {
        this.removeSuggestion(editor);
      }
      return;
    }

    if (this.pendingSuggestion) {
      this.removeSuggestion(editor);
    }

    const completionLines = this.buildCompletionLines(match, codeOnlyLineText);
    const requestId = ++this.suggestionRequestId;
    void this.showSuggestion(
      editor,
      lineNumber,
      completionLines,
      match.key,
      requestId,
    );

    this.showMatchNotification(match);
  }

  /**
   * Main listener called from extension.js. It routes each content change to the
   * right concern: deletion/rejection, formatting-safe navigation edits, or
   * dynamic pattern matching for new code.
   */
  handleTextChange(event) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || this.isAccepting || this.isAdjustingPreviewSpace) return;

    const document = editor.document;

    event.contentChanges.forEach((change) => {
      const lineNumber = change.range.start.line;
      if (lineNumber < 0 || lineNumber >= document.lineCount) {
        this.removeSuggestion(editor);
        return;
      }

      const codeOnlyLineText = this.getCodeOnlyLineText(document, lineNumber);

      if (change.text === "" && change.rangeLength > 0) {
        this.handleDeletionChange(editor, lineNumber);
        return;
      }

      // Enter/newline/indentation edits are navigation or format actions, not
      // code typing that should trigger a new FaultyAI suggestion.
      if (!this.isCodeTypingChange(change)) {
        this.handleNonCodeChange(editor, lineNumber);
        return;
      }

      if (this.shouldSkipAcceptedLine(lineNumber, codeOnlyLineText)) {
        return;
      }

      this.handlePotentialSuggestion(editor, lineNumber, codeOnlyLineText);
    });
  }
}

module.exports = { SuggestionController };
