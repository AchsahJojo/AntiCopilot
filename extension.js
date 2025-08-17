const vscode = require("vscode");

class SuggestionController {
  constructor() {
    this.greyDecoration = vscode.window.createTextEditorDecorationType({
      after: {
        color: "#888888",
        fontStyle: "italic",
        margin: "0 0 0 10px",
      },
    });

    this.patterns = {
      variableDependent: {
        Scanner: () => ` = new Scanner(System);`,
        BufferedReader: () =>
          ` = new BufferedReader(new FileReader("input.txt"));`,
        // run time NullPointerException (NPE)
        //String[]: () => `= new String[3] \n greetings[0].toLowerCase();`, // creates an array of 3 null elements
      },
      generic: {
        for: [" (int i = 0; i < 10; i++) {", "System.println(i);", "}"],
        while: [" (x < 10) {", "System.out.println(x);", "  x++;", "  }"],
        //run time ArrayIndexOutOfBoundsException
        "int[]": [
          "numbers = {1, 2, 3, 4, 5};",
          "for (int i = 0; i <= numbers.length; i++) {", // BUG: <= instead of <
          "    System.out.println(numbers[i]);", // BUG: Will crash at i=5
          "}",
        ],
      },
    };

    this.activePattern = new Map();

    this.pendingSuggestion = {
      line: null,
      text: "",
    };
    this.acceptedLines = new Set();
  }
  async formatInsertedCode(editor, startLine, endLine) {
    try {
      // Select the range of inserted code
      const startPos = new vscode.Position(startLine, 0);
      const endPos = new vscode.Position(
        endLine,
        editor.document.lineAt(endLine).text.length
      );

      // Set selection
      editor.selection = new vscode.Selection(startPos, endPos);

      // Format the selection (includes indentation)
      await vscode.commands.executeCommand("editor.action.formatSelection");

      return true;
    } catch (error) {
      console.error("Error formatting code:", error);
      return false;
    }
  }

  findTriggerWord(lineText) {
    for (const key in this.patterns.generic) {
      const regex = new RegExp(`\\b${key}\\b`);
      if (regex.test(lineText)) {
        return key; // Return the first matching trigger word
      }
    }
    for (const key in this.patterns.variableDependent) {
      const regex = new RegExp(`\\b${key}\\s+(\\w+)\\b`);
      if (regex.test(lineText)) {
        return key; // Return the first matching trigger word
      }
    }
    return ""; // No trigger word found
  }

  async showSuggestion(editor, lineNumber, suggestionText, regex) {
    if (!Array.isArray(suggestionText)) {
      //normal way
      let line = editor.document.lineAt(lineNumber);
      let range = new vscode.Range(line.range.start, line.range.end);
      let decoration = [];
      decoration.push({
        range,
        renderOptions: {
          // This approach is limited to decorating a single line because
          //  the after property only appends text to the end of the current line.
          after: {
            contentText: suggestionText,
          },
        },
      });
      editor.setDecorations(this.greyDecoration, decoration);
      this.pendingSuggestion = { line: lineNumber, text: suggestionText };
      this.activePattern.set(lineNumber, regex);
      return;
    }

    // for multi line suggestions
    const doc = editor.document;
    const decoration = [];

    // Determine if we should use single line or multi-line suggestion
    let singleLine = false;

    /*
     // if there is content in a line, and the number of 
     // lines the suggested text is taking up is less than the number 
     // of lines it takes to get to the line with content in it, then do 
     // proceed to do multiline suggestion, however, if suggested text is 
     // taking up more lines than it takes to get to the next line with content, 
     // then peroceed to do single line suggestion. so if i do a while loop on line 17 and
     //  then go one line above to line 16 and do another while loop which takes up 4 lines of code,
     //  I will do the onw line suggestion because the number of lines the while loop takes up is more
     //  than the distance between line 16 and 17 (how far the next line of content aka the next while loop) 
    */

    //if the distance to next content is less than 2 lines, do single line
    // else if content is found, and the suggestText lengrth is more, then inswrt the nymber of suggestioTextLength+1 number of lines to the code so that multiline suggestion can be activated

    //find the next line with content
    let nextContentLineDistance = null;
    for (let i = 1; i <= doc.lineCount - lineNumber; i++) {
      const checkLineNum = lineNumber + i;
      if (checkLineNum < doc.lineCount) {
        const lineExists = doc.lineAt(checkLineNum);
        console.log("Line exsit: " + lineExists);
        if (!lineExists.isEmptyOrWhitespace) {
          nextContentLineDistance = i;
          console.log("distance " + nextContentLineDistance);
          break;
        }
      }
    }
    //suggestion mode based on distance to next content line
    if (nextContentLineDistance !== null) {
      if (nextContentLineDistance <= 1) {
        // If the next content line is within 1 lines, we will use single line suggestion
        singleLine = true;
        console.log("Single line used");
      }
      // If the suggestion text takes up more lines than the distance to the next content line,
      // we will use single line suggestion
      else if (suggestionText.length > nextContentLineDistance) {
        const numLinesToInsert =
          suggestionText.length - nextContentLineDistance + 1;

        console.log("MultiLine used");

        await editor.edit((editBuilder) => {
          // Insert empty lines to create space for the suggestion
          const insertPosition = new vscode.Position(
            lineNumber + nextContentLineDistance,
            0
          );
          const newLines = "\n".repeat(numLinesToInsert);
          editBuilder.insert(insertPosition, newLines);
        });

        console.log("added extra lines");

        singleLine = false;
      }
      // else {
      //   singleLine = false;
      //   console.log("No content found, then default to multiLine");
      // }
    } else {
      // If no content line is found, default to multi-line suggestion
      singleLine = false;
      console.log("No content found, default multi-line");
    }

    // Now decorate the new lines
    if (singleLine) {
      // For single line, combine all suggestion text into one decoration
      const line = doc.lineAt(lineNumber);
      const range = new vscode.Range(line.range.start, line.range.end);

      // Combine all suggestion lines into a single string
      const combinedSuggestion = suggestionText.join(" ");

      decoration.push({
        range,
        renderOptions: {
          after: {
            contentText: combinedSuggestion,
          },
        },
      });
    } else {
      // For multi-line, create separate decorations for each line
      for (let i = 0; i < suggestionText.length; i++) {
        const decoratedLineNumber = lineNumber + i;

        if (decoratedLineNumber >= doc.lineCount) continue;

        const line = doc.lineAt(decoratedLineNumber);
        const range = new vscode.Range(line.range.start, line.range.end);

        decoration.push({
          range,
          renderOptions: {
            after: {
              contentText: suggestionText[i],
            },
          },
        });
      }
    }

    // cursor position
    // we need to find the trigger word in the line and then set the cursor position to
    // the end of that word so that the user can continue typing
    // this is the line where the user typed the trigger word
    const triigerLine = doc.lineAt(lineNumber);
    const triggerWord = this.findTriggerWord(triigerLine.text);
    const triggerEndPosition =
      triigerLine.text.indexOf(triggerWord) + triggerWord.length;
    const cursorPosition = new vscode.Position(lineNumber, triggerEndPosition);
    editor.selection = new vscode.Selection(cursorPosition, cursorPosition);

    editor.setDecorations(this.greyDecoration, decoration);

    // Store suggestion for acceptance later
    this.pendingSuggestion = {
      line: lineNumber,
      text: suggestionText.join("\n"),
    };
    this.activePattern.set(lineNumber, regex);
  }

  removeSuggestion(editor) {
    editor.setDecorations(this.greyDecoration, []);
    this.pendingSuggestion = { line: null, text: "" };
  }
  handleEditorBlur() {
    // Clear the ghost suggestion when the editor loses focus
    this.removeSuggestion(vscode.window.activeTextEditor);
  }

  acceptSuggestion(editor) {
    if (this.pendingSuggestion.line === null) return;

    const line = editor.document.lineAt(this.pendingSuggestion.line);
    const fullText = line.text + this.pendingSuggestion.text;

    editor
      .edit((editBuilder) => {
        const range = new vscode.Range(line.range.start, line.range.end);
        editBuilder.replace(range, fullText);
      })
      .then(async () => {
        //cursor
        const startOffset = editor.document.offsetAt(line.range.start);
        const endOffset = startOffset + fullText.length;
        const cursorPos = editor.document.positionAt(endOffset);
        editor.selection = new vscode.Selection(cursorPos, cursorPos);

        this.acceptedLines.add(this.pendingSuggestion.line);

        // Fix: Remove ghost suggestion cleanly after edit completes
        setTimeout(async () => {
          // Format the entire document
          await vscode.commands.executeCommand("editor.action.formatDocument");
          this.removeSuggestion(editor);
        }, 0);
      })
      .catch((error) => {
        console.error("Error accepting suggestion:", error);
      });
  }

  handleTextChange(event) {
    const editor = vscode.window.activeTextEditor;
    //if (!editor || !event.document.fileName.endsWith(".js")) return;
    if (!editor) return;

    const document = editor.document;

    event.contentChanges.forEach((change) => {
      // check if there is a pattern in activePattern and if there is, then we will checlk
      // that pattern again aganist the current line of text and if it doest match anymore
      // then you delete suggested code and set activePattern back to null and continue on
      // this into code we alr set this this.activePattern = regex;
      const line = document.lineAt(change.range.start);
      const lineText = line.text;

      if (change.text === "") {
        if (this.activePattern.has(line.lineNumber)) {
          this.activePattern.delete(line.lineNumber);
          editor.setDecorations(this.greyDecoration, []);
        }
        return;
      }

      if (this.activePattern.has(line.lineNumber)) {
        const regex = this.activePattern.get(line.lineNumber);
        if (!regex.test(lineText)) {
          editor.setDecorations(this.greyDecoration, []);
          this.activePattern.delete(line.lineNumber); // Remove the pattern for this line
          this.pendingSuggestion.line = null;
          this.pendingSuggestion.text = "";
        }
      }

      // if (this.acceptedLines.has(line.lineNumber)) return;
      if (this.acceptedLines.has(line.lineNumber)) {
        // Recheck: if line is no longer a match, remove it from acceptedLines
        // const triggers = Object.keys(this.patterns);
        const triggers = [
          ...Object.keys(this.patterns.variableDependent),
          ...Object.keys(this.patterns.generic),
        ];
        const stillMatches = triggers.some((key) => {
          const regex = new RegExp(`\\b${key}\\b`);
          return regex.test(lineText);
        });

        if (!stillMatches) {
          this.acceptedLines.delete(line.lineNumber);
        } else {
          return; // still matches original trigger, so block re-suggestion
        }
      }

      if (this.detectDeletion(change)) {
        const lineNum = change.range.start.line;
        const lineText = document.lineAt(lineNum).text;
        if (lineText.trim() === "") {
          this.acceptedLines.delete(lineNum);
        }
        this.removeSuggestion(editor);
        //  this.activePattern.delete(line.lineNumber);
        return;
      }

      // Check generic patterns **separately**
      for (const key in this.patterns.generic) {
        const regex = new RegExp(`\\b${key}\\b`);
        if (regex.test(lineText)) {
          //re-check all patterns for the rewritten line:
          this.activePattern.set(line.lineNumber, regex);
          this.acceptedLines.delete(line.lineNumber);
          this.showSuggestion(
            editor,
            line.lineNumber,
            this.patterns.generic[key],
            regex
          );
          vscode.window.showInformationMessage(
            `AntiCopilot suggestion for "${key}"`
          );
          break;
        }
      }

      // Check variable-dependent patterns
      for (const key in this.patterns.variableDependent) {
        const regex = new RegExp(`\\b${key}\\s+(\\w+)\\b`);
        const match = regex.exec(lineText);

        if (match) {
          const variableName = match[1];
          this.activePattern.set(line.lineNumber, regex);
          this.acceptedLines.delete(line.lineNumber);

          const suggestion = this.patterns.variableDependent[key]({
            variableName,
          });
          this.showSuggestion(editor, line.lineNumber, suggestion, regex);
          vscode.window.showInformationMessage(
            `AntiCopilot: Variable pattern matched for "${key}" with variable "${variableName}"`
          );
          break; // Stop checking other variable-dependent patterns
        }
      }
    });
  }

  detectDeletion(change) {
    return change.text === "" && change.rangeLength > 0;
  }
}

let controller;

function activate(context) {
  console.log("AntiCopilot extension activated!");

  controller = new SuggestionController();

  // Register hover provider
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { scheme: "file", language: "java" },
      {
        provideHover(document, position) {
          // Check if there's a pending suggestion for the current line
          const editor = vscode.window.activeTextEditor;
          if (!editor || !controller.pendingSuggestion.text) return;

          const line = editor.document.lineAt(position.line);
          if (line.lineNumber === controller.pendingSuggestion.line) {
            return new vscode.Hover(
              `Full Suggestion:\n\`\`\`java\n${controller.pendingSuggestion.text}\n\`\`\``
            );
          }
        },
      }
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) =>
      controller.handleTextChange(event)
    )
  );
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((newEditor) => {
      if (!newEditor) {
        // Editor lost focus entirely (e.g., clicked sidebar or outside VSCode)
        controller.handleEditorBlur();
      } else {
        // Optionally handle switching between editors
        console.log("Switched to a new editor:", newEditor.document.fileName);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("faultyai.acceptSuggestion", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        controller.acceptSuggestion(editor);
      }
    })
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
