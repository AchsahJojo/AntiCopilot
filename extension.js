const vscode = require("vscode");
const { SuggestionController } = require("./src/SuggestionController");
const {
  AutoClosingBracketsManager,
} = require("./src/AutoClosingBracketsManager");

let controller;
let bracketsManager;

function activate(context) {
  console.log("FaultyAI extension activated!");

  controller = new SuggestionController();
  bracketsManager = new AutoClosingBracketsManager();

  // Programmatically set workspace and Java-language auto-closing brackets to "never".
  // Do NOT push the returned Promise into context.subscriptions (it's not a Disposable).
  bracketsManager.applyWorkspaceSettings();

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

  if (bracketsManager) {
    bracketsManager.restoreWorkspaceSettings();
  }
}

module.exports = {
  activate,
  deactivate,
};
