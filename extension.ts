import * as vscode from "vscode";
import { SuggestionController } from "./src/SuggestionController";

interface AutoClosingBracketsManagerLike {
  applyWorkspaceSettings(): void;
  restoreWorkspaceSettings(): void;
}

// Created on activation and reused by event handlers until extension deactivation.
let controller: SuggestionController | undefined;
// Kept for compatibility with optional bracket manager integration.
let bracketsManager: AutoClosingBracketsManagerLike | undefined;

export function activate(context: vscode.ExtensionContext): void {
  console.log("FaultyAI extension activated!");

  controller = new SuggestionController();

  // Hover shows the full suggestion body when the cursor is on the suggestion line.
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { scheme: "file", language: "java" },
      {
        provideHover(_document, position) {
          if (!controller?.pendingSuggestion) {
            return undefined;
          }

          const lineNumber = position.line;
          if (lineNumber === controller.pendingSuggestion.line) {
            return new vscode.Hover(
              `**FaultyAI Suggestion** (Press Tab to accept)\n\`\`\`java\n${controller.pendingSuggestion.text}\n\`\`\``,
            );
          }

          return undefined;
        },
      },
    ),
  );

  // Main input stream: all suggestion detection starts from text change events.
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) =>
      controller?.handleTextChange(event),
    ),
  );

  // Clear stale decoration when editor focus is lost/switched.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((newEditor) => {
      if (!newEditor) {
        controller?.removeSuggestion(vscode.window.activeTextEditor);
      }
    }),
  );

  // Applies the currently displayed suggestion into the document.
  context.subscriptions.push(
    vscode.commands.registerCommand("faultyai.acceptSuggestion", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        void controller?.acceptSuggestion(editor);
      }
    }),
  );
}

export function deactivate(): void {
  controller?.removeSuggestion(vscode.window.activeTextEditor);
  bracketsManager?.restoreWorkspaceSettings();
}
