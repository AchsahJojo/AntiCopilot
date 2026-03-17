import * as vscode from "vscode";
import { SuggestionController } from "./src/SuggestionController";

interface AutoClosingBracketsManagerLike {
  applyWorkspaceSettings(): void;
  restoreWorkspaceSettings(): void;
}

const { AutoClosingBracketsManager } = require("./src/AutoClosingBracketsManager") as {
  AutoClosingBracketsManager: new () => AutoClosingBracketsManagerLike;
};

let controller: SuggestionController | undefined;
let bracketsManager: AutoClosingBracketsManagerLike | undefined;

export function activate(context: vscode.ExtensionContext): void {
  console.log("FaultyAI extension activated!");

  controller = new SuggestionController();
  bracketsManager = new AutoClosingBracketsManager();

  bracketsManager.applyWorkspaceSettings();

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

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) =>
      controller?.handleTextChange(event),
    ),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((newEditor) => {
      if (!newEditor) {
        controller?.removeSuggestion(vscode.window.activeTextEditor);
      }
    }),
  );

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
