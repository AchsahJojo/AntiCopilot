const vscode = require("vscode");
const path = require("path");
const { SuggestionController } = require("./src/SuggestionController");
const { getPatternsFilePath } = require("./src/patterns");
const {
  AutoClosingBracketsManager,
} = require("./src/AutoClosingBracketsManager");

let controller;
let bracketsManager;
let patternWatchDisposables = [];

function disposePatternWatcher() {
  for (const disposable of patternWatchDisposables) {
    disposable.dispose();
  }
  patternWatchDisposables = [];
}

function watchPatternsFile(context) {
  disposePatternWatcher();

  const patternsFilePath = getPatternsFilePath();
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      path.dirname(patternsFilePath),
      path.basename(patternsFilePath),
    ),
  );

  const reloadPatterns = () => {
    if (!controller) return;
    controller.reloadPatterns();
    console.log(`FaultyAI patterns reloaded from ${patternsFilePath}`);
  };

  patternWatchDisposables = [
    watcher,
    watcher.onDidChange(reloadPatterns),
    watcher.onDidCreate(reloadPatterns),
    watcher.onDidDelete(reloadPatterns),
  ];
  context.subscriptions.push(...patternWatchDisposables);
}

function activate(context) {
  console.log("FaultyAI extension activated!");

  controller = new SuggestionController();
  bracketsManager = new AutoClosingBracketsManager();
  watchPatternsFile(context);

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
        return;
      }
      controller.syncSuggestionContextForEditor(newEditor);
    }),
  );

  // Keep Tab-accept enabled only when caret is on the suggestion line.
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      controller.syncSuggestionContextForEditor(event.textEditor);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("faultyai.patternsFile")) return;

      controller.reloadPatterns();
      watchPatternsFile(context);
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
  disposePatternWatcher();

  if (controller) {
    controller.removeSuggestion(vscode.window.activeTextEditor);
  }

  if (bracketsManager) {
    bracketsManager.restoreWorkspaceSettings();
  }
}
//hello!
module.exports = {
  activate,
  deactivate,
};
