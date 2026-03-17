import * as vscode from "vscode";
import {
  createPatterns,
  type GenericPatternEntry,
  type Patterns,
  type SuggestionValue,
  type VariableDependentPatternEntry,
} from "./patterns";


interface PreviewSpacer {
  anchorLine: number;
  count: number;
}

interface PendingSuggestion {
  line: number;
  text: string;
  lines: string[];
  displayMode: "single" | "multi";
  patternKey: string | null;
}

interface GenericTriggerMatch {
  type: "generic";
  key: string;
  regex: RegExp;
  suggestion: string[];
}

interface VariableDependentTriggerMatch {
  type: "variableDependent";
  key: string;
  regex: RegExp;
  variableName: string;
  suggestion: string[];
}

type TriggerMatch = GenericTriggerMatch | VariableDependentTriggerMatch;

// Coordinates ghost suggestion rendering, acceptance, and suppression state.
export class SuggestionController {
  private greyDecoration: vscode.TextEditorDecorationType;
  private patterns: Patterns;
  public pendingSuggestion: PendingSuggestion | null;
  private acceptedLines: Set<number>;
  private isAccepting: boolean;
  private isAdjustingPreviewSpace: boolean;
  // Monotonic id to ignore stale async render requests.
  private suggestionRequestId: number;
  // Per-line suppression so a deleted suggestion does not immediately reappear.
  private superpressedPatterns: Map<number, Set<string>>;
  // Tracks temporary lines inserted to preview multiline suggestions.
  private previewSpacer: PreviewSpacer | null;

  // Initializes decoration style and all controller state caches.
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
    this.superpressedPatterns = new Map();
    this.previewSpacer = null;
  }

  // Normalizes any suggestion payload into a safe array of strings.
  private normalizeSuggestionLines(suggestion: SuggestionValue): string[] {
    const lines = Array.isArray(suggestion) ? suggestion : [suggestion];
    return lines.map((line) => String(line ?? ""));
  }

  // Removes the longest matching already-typed token prefix from `text`.
  private removeLeadingTokens(text: string, tokens: string[]): string {
    const sorted = [...tokens].sort((a, b) => b.length - a.length);
    for (const token of sorted) {
      if (token && text.startsWith(token)) {
        return text.slice(token.length);
      }
    }

    return text;
  }

  // Resolves one indentation step based on editor tab/space settings.
  private getIndentUnit(editor: vscode.TextEditor): string {
    const insertSpaces = editor.options.insertSpaces !== false;
    const tabSize = Number(editor.options.tabSize) || 2;
    return insertSpaces ? " ".repeat(tabSize) : "\t";
  }

  // Builds preview lines with indentation that follows Java block structure.
  private buildIndentedSuggestionLines(
    editor: vscode.TextEditor,
    lineNumber: number,
    lines: string[],
  ): string[] {
    if (!Array.isArray(lines) || lines.length === 0) {
      return [];
    }

    const baseIndent = editor.document.lineAt(lineNumber).text.match(/^\s*/)![0];
    const indentUnit = this.getIndentUnit(editor);
    const result: string[] = [];
    let blockDepth = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const rawLine = String(lines[i] ?? "");

      if (i === 0) {
        // First line stays relative to the user's cursor line.
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

      // Dedent closing tokens first so `}` aligns correctly in the preview.
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

  // Converts leading whitespace to visible decoration-safe characters.
  private renderDecorationWhitespace(editor: vscode.TextEditor, line: string): string {
    const tabSize = Number(editor.options.tabSize) || 2;
    return line.replace(/^[ \t]+/, (leading) =>
      leading.replace(/\t/g, " ".repeat(tabSize)).replace(/ /g, "\u00A0"),
    );
  }

  // Counts consecutive blank lines under a line to decide preview layout strategy.
  private countAvailableEmptyLines(doc: vscode.TextDocument, lineNumber: number): number {
    let availableLines = 0;
    for (let i = lineNumber + 1; i < doc.lineCount; i += 1) {
      const line = doc.lineAt(i);
      if (line.isEmptyOrWhitespace) {
        availableLines += 1;
      } else {
        break;
      }
    }

    return availableLines;
  }

  // Deletes temporary spacer lines previously inserted for multiline preview.
  private async clearPreviewSpace(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor || !this.previewSpacer) {
      return;
    }

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
      // Remove only the range that was injected for preview spacing.
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

  // Ensures enough empty lines exist below cursor to render multiline ghost text.
  private async ensurePreviewSpace(
    editor: vscode.TextEditor | undefined,
    lineNumber: number,
    requiredExtraLines: number,
  ): Promise<void> {
    if (!editor || requiredExtraLines <= 0) {
      return;
    }

    const anchorLine = lineNumber + 1;
    if (this.previewSpacer && this.previewSpacer.anchorLine !== anchorLine) {
      await this.clearPreviewSpace(editor);
    }

    const doc = editor.document;
    if (anchorLine > doc.lineCount) {
      return;
    }

    const availableLines = this.countAvailableEmptyLines(doc, lineNumber);
    const needed = requiredExtraLines - availableLines;
    if (needed <= 0) {
      return;
    }

    const insertPosition = new vscode.Position(anchorLine, 0);
    const spacerText = "\n".repeat(needed);

    this.isAdjustingPreviewSpace = true;
    try {
      // Insert empty lines under the anchor to render multiline ghost text cleanly.
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

  // Finds the first matching pattern (respecting suppression state for a line).
  private findTriggerMatch(lineText: string, lineNumber?: number): TriggerMatch | null {
    // Generic patterns are evaluated first.
    for (const entry of this.patterns.generic) {
      const match = entry.trigger.exec(lineText);
      if (!match) {
        continue;
      }

      const patternKey = entry.trigger.toString();
      if (lineNumber !== undefined) {
        const suppressedForLine = this.superpressedPatterns.get(lineNumber);
        if (suppressedForLine && suppressedForLine.has(patternKey)) {
          return null;
        }
      }

      const suggestionValue =
        typeof entry.suggestion === "function"
          ? entry.suggestion({ match })
          : entry.suggestion;

      return {
        type: "generic",
        key: patternKey,
        regex: entry.trigger,
        suggestion: this.normalizeSuggestionLines(suggestionValue),
      };
    }

    for (const entry of this.patterns.variableDependent) {
      const match = entry.trigger.exec(lineText);
      if (!match) {
        continue;
      }

      const patternKey = entry.trigger.toString();
      if (lineNumber !== undefined) {
        const suppressedForLine = this.superpressedPatterns.get(lineNumber);
        if (suppressedForLine && suppressedForLine.has(patternKey)) {
          return null;
        }
      }

      const variableName = String(match[1] ?? "");
      return {
        type: "variableDependent",
        key: patternKey,
        regex: entry.trigger,
        variableName,
        suggestion: this.normalizeSuggestionLines(entry.builder({ variableName })),
      };
    }

    return null;
  }

  // Renders ghost text decorations and records the pending suggestion metadata.
  private async showSuggestion(
    editor: vscode.TextEditor,
    lineNumber: number,
    suggestionLines: string[] | string,
    patternKey: string | null = null,
    requestId: number | null = null,
  ): Promise<void> {
    const doc = editor.document;
    const decorations: vscode.DecorationOptions[] = [];

    const lines = this.normalizeSuggestionLines(suggestionLines);
    const indentedLines = this.buildIndentedSuggestionLines(editor, lineNumber, lines);
    const displayLines = indentedLines.map((line) =>
      this.renderDecorationWhitespace(editor, line),
    );

    if (lines.length > 1) {
      await this.ensurePreviewSpace(editor, lineNumber, lines.length - 1);
    }

    // If another keystroke happened, drop this outdated render.
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
      for (let i = 0; i < displayLines.length; i += 1) {
        const targetLine = lineNumber + i;
        if (targetLine >= doc.lineCount) {
          break;
        }

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
  }

  // Clears current suggestion state and decorations from the active editor.
  public removeSuggestion(editor: vscode.TextEditor | undefined): void {
    // Invalidate pending async renders and clear any temporary preview spacing.
    this.suggestionRequestId += 1;
    if (editor) {
      editor.setDecorations(this.greyDecoration, []);
      void this.clearPreviewSpace(editor);
    }

    this.pendingSuggestion = null;
  }

  // Commits the currently pending suggestion into the document as real text.
  public async acceptSuggestion(editor: vscode.TextEditor): Promise<void> {
    if (!this.pendingSuggestion || this.isAccepting) {
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

      let fullText = currentLine.text;
      for (let i = 0; i < indentedLines.length; i += 1) {
        const suggestionLine = indentedLines[i];
        if (i === 0) {
          fullText += suggestionLine;
        } else {
          fullText += `\n${suggestionLine}`;
        }
      }

      await editor.edit((editBuilder) => {
        const range = new vscode.Range(
          currentLine.range.start,
          currentLine.range.end,
        );
        editBuilder.replace(range, fullText);
      });

      this.acceptedLines.add(lineNumber);
      this.removeSuggestion(editor);

      const insertedLines = lines.length;
      const lastLineNumber = lineNumber + insertedLines - 1;
      const lastLine = editor.document.lineAt(lastLineNumber);
      const endPosition = new vscode.Position(
        lastLineNumber,
        lastLine.text.length,
      );
      editor.selection = new vscode.Selection(endPosition, endPosition);

      if (lines.length > 1) {
        // Format after the edit settles so the inserted block is consistently shaped.
        setTimeout(async () => {
          try {
            const startPos = new vscode.Position(lineNumber, 0);
            const endPos = new vscode.Position(
              lastLineNumber,
              editor.document.lineAt(lastLineNumber).text.length,
            );
            editor.selection = new vscode.Selection(startPos, endPos);
            await vscode.commands.executeCommand(
              "editor.action.formatSelection",
            );

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

  // Utility matcher used by logic that checks if an accepted line still matches any pattern.
  private findPattern(lineText: string): GenericPatternEntry | VariableDependentPatternEntry | null {
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

  // Main event pipeline: classify edit, update suppression/acceptance state, and render preview.
  public handleTextChange(event: vscode.TextDocumentChangeEvent): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || this.isAccepting || this.isAdjustingPreviewSpace) {
      return;
    }

    const document = editor.document;

    event.contentChanges.forEach((change) => {
      const lineNumber = change.range.start.line;
      const line = document.lineAt(lineNumber);
      const lineText = line.text;

      if (change.text === "" && change.rangeLength > 0) {
        // If user deletes a live suggestion, suppress that pattern for this line.
        if (
          this.pendingSuggestion &&
          this.pendingSuggestion.line === lineNumber
        ) {
          const patternKey = this.pendingSuggestion.patternKey;
          if (patternKey) {
            if (!this.superpressedPatterns.has(lineNumber)) {
              this.superpressedPatterns.set(lineNumber, new Set());
            }
            this.superpressedPatterns.get(lineNumber)?.add(patternKey);
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

      if (this.acceptedLines.has(lineNumber)) {
        // Do not re-suggest while the accepted line still matches.
        const match = this.findTriggerMatch(lineText, lineNumber);
        if (!match) {
          this.acceptedLines.delete(lineNumber);
        } else {
          return;
        }
      }

      const match = this.findTriggerMatch(lineText, lineNumber);

      if (match) {
        if (this.pendingSuggestion) {
          this.removeSuggestion(editor);
        }

        // Remove already-typed prefix from suggestion so preview shows only the remainder.
        const currentLineText = lineText.trimStart();
        const actualMatch = match.regex.exec(currentLineText);
        const matchedText = actualMatch ? actualMatch[0] : "";

        let res = "";
        let resFinal: string | string[];

        if (match.suggestion.length > 1) {
          res = this.removeLeadingTokens(currentLineText, [matchedText]);

          const firstLine = match.suggestion[0];
          const firstLineProcessed = this.removeLeadingTokens(firstLine, [res]);
          resFinal = [firstLineProcessed, ...match.suggestion.slice(1)];

          console.log(`Res = ${res}ResFinal = ${resFinal}`);

          const requestId = ++this.suggestionRequestId;
          void this.showSuggestion(
            editor,
            lineNumber,
            resFinal,
            match.key,
            requestId,
          );
        } else {
          res = this.removeLeadingTokens(currentLineText, [matchedText]);
          resFinal = this.removeLeadingTokens(match.suggestion.toString(), [res]);

          console.log(`Res = ${res}ResFinal = ${resFinal}`);

          const requestId = ++this.suggestionRequestId;
          void this.showSuggestion(
            editor,
            lineNumber,
            [resFinal],
            match.key,
            requestId,
          );
        }

        const varInfo =
          match.type === "variableDependent"
            ? ` with variable "${match.variableName}"`
            : "";
        void vscode.window.showInformationMessage(
          `FaultyAI suggestion for "${match.key}"${varInfo}`,
        );
      } else if (
        this.pendingSuggestion &&
        this.pendingSuggestion.line === lineNumber
      ) {
        this.removeSuggestion(editor);
      }
    });
  }
}
