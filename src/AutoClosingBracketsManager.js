const vscode = require("vscode");

class AutoClosingBracketsManager {
  constructor() {
    this.originalAutoClosingBrackets = undefined;
    this.originalJavaAutoClosingBrackets = undefined;
  }

  applyWorkspaceSettings() {
    try {
      const config = vscode.workspace.getConfiguration();

      // Save current values so we can restore them on deactivate
      this.originalAutoClosingBrackets = config.get(
        "editor.autoClosingBrackets",
      );
      this.originalJavaAutoClosingBrackets = config.get(
        "[java].editor.autoClosingBrackets",
      );

      // Update workspace-level editor setting
      config
        .update(
          "editor.autoClosingBrackets",
          "never",
          vscode.ConfigurationTarget.Workspace,
        )
        .catch((err) =>
          console.error("Failed to update editor.autoClosingBrackets:", err),
        );

      // Also set language-specific setting for Java to be safe
      config
        .update(
          "[java].editor.autoClosingBrackets",
          "never",
          vscode.ConfigurationTarget.Workspace,
        )
        .catch((err) =>
          console.error(
            "Failed to update [java].editor.autoClosingBrackets:",
            err,
          ),
        );
    } catch (err) {
      console.error("Error reading/updating configuration:", err);
    }
  }

  restoreWorkspaceSettings() {
    try {
      const config = vscode.workspace.getConfiguration();
      if (typeof this.originalAutoClosingBrackets !== "undefined") {
        config
          .update(
            "editor.autoClosingBrackets",
            this.originalAutoClosingBrackets,
            vscode.ConfigurationTarget.Workspace,
          )
          .catch((err) =>
            console.error("Failed to restore editor.autoClosingBrackets:", err),
          );
      }
      if (typeof this.originalJavaAutoClosingBrackets !== "undefined") {
        config
          .update(
            "[java].editor.autoClosingBrackets",
            this.originalJavaAutoClosingBrackets,
            vscode.ConfigurationTarget.Workspace,
          )
          .catch((err) =>
            console.error(
              "Failed to restore [java].editor.autoClosingBrackets:",
              err,
            ),
          );
      }
    } catch (err) {
      console.error("Error restoring configuration on deactivate:", err);
    }
  }
}

module.exports = { AutoClosingBracketsManager };
