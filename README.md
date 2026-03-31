# AntiCopilot

_AntiCopilot_ is a Visual Studio Code extension designed to emulate GitHub Copilot, but instead of suggesting correct code, it intentionally generates code with errors. This helps students improve their debugging skills by forcing them to find and fix mistakes in AI-generated code.

## Features

- **Ghost Suggestions**: Handles single and multiple line code suggestions interchangeably.
- **Beginner Java Pattern Detection**: Detects common beginner Java patterns and replaces them with intentionally buggy code.
- **Real-time Cursor Tracking**: Implements ghost-style coding suggestions that follow your cursor position in real time.
- **Advanced Editor State Management**: Handles multi-line suggestions, variable naming conventions, and manages editor state for deletion, insertion, and other edge cases.
- **Activation Events & Reactive Behavior**: Utilizes VS Code activation events for responsive and object-oriented problem solving.
- **Code Change Notifications**: Notifies users when code changes occur, helping track and understand the impact of edits.

## Installation and Use

1. Open VS Code.
2. Create a Java file.
3. Check if the extension is running by opening the Command Palette and selecting "Developer: Show Running Extensions". Look for `undefined_publisher.faultyai`.
4. Once activated, start typing `Scanner s`, `while`, or `for` to see the autocompletion suggestions.
