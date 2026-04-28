const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_PATTERNS_FILE = path.join(__dirname, "patterns.txt");

/**
 * @typedef {string | string[]} SuggestionValue
 */

/**
 * @typedef {object} GenericPatternEntry
 * @property {RegExp} trigger
 * @property {SuggestionValue | ((args: { match: RegExpExecArray }) => SuggestionValue)} suggestion
 */

/**
 * @typedef {object} VariableDependentPatternEntry
 * @property {RegExp} trigger
 * @property {(args: { variableName: string, match?: RegExpExecArray }) => SuggestionValue} builder
 */

/**
 * @typedef {object} Patterns
 * @property {VariableDependentPatternEntry[]} variableDependent
 * @property {GenericPatternEntry[]} generic
 */

function getVscode() {
  try {
    return require("vscode");
  } catch {
    return null;
  }
}

function expandHome(filePath) {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function getWorkspaceRoot() {
  const vscode = getVscode();
  const workspaceFolder = vscode?.workspace?.workspaceFolders?.[0];
  return workspaceFolder?.uri?.fsPath ?? null;
}

function getConfiguredPatternsPath() {
  const vscode = getVscode();
  return vscode?.workspace
    ?.getConfiguration("faultyai")
    ?.get("patternsFile", "");
}

function getPatternsFilePath(patternsFilePath = getConfiguredPatternsPath()) {
  const configuredPath =
    typeof patternsFilePath === "string" ? patternsFilePath.trim() : "";

  if (!configuredPath) {
    return DEFAULT_PATTERNS_FILE;
  }

  const expandedPath = expandHome(configuredPath);
  if (path.isAbsolute(expandedPath)) {
    return expandedPath;
  }

  return path.resolve(getWorkspaceRoot() ?? process.cwd(), expandedPath);
}

function createEmptyPatterns() {
  return {
    variableDependent: [],
    generic: [],
  };
}

function readDirectiveValue(line, directive) {
  const prefix = `${directive}:`;
  if (!line.startsWith(prefix)) return null;

  const value = line.slice(prefix.length);
  if (value.startsWith(" ") || value.startsWith("\t")) {
    return value.slice(1);
  }
  return value;
}

function interpolateSuggestionLine(line, variableName, match) {
  return line
    .replace(/\{\{variableName\}\}/g, variableName ?? "")
    .replace(/\{\{(\d+)\}\}/g, (_, groupIndex) => {
      return match?.[Number(groupIndex)] ?? "";
    });
}

function warnPattern(sourceLabel, lineNumber, message) {
  const location = lineNumber ? `${sourceLabel}:${lineNumber}` : sourceLabel;
  console.warn(`[FaultyAI] ${location}: ${message}`);
}

function parsePatternsText(text, sourceLabel = "patterns.txt") {
  const patterns = createEmptyPatterns();
  let current = {
    trigger: "",
    type: "",
    suggestions: [],
    lineNumber: null,
  };

  function resetCurrent() {
    current = {
      trigger: "",
      type: "",
      suggestions: [],
      lineNumber: null,
    };
  }

  function flushCurrent() {
    const hasBlock =
      current.trigger || current.type || current.suggestions.length > 0;
    if (!hasBlock) return;

    const missing = [];
    if (!current.trigger) missing.push("TRIGGER");
    if (!current.type) missing.push("TYPE");
    if (current.suggestions.length === 0) missing.push("SUGGESTION");

    if (missing.length > 0) {
      warnPattern(
        sourceLabel,
        current.lineNumber,
        `skipping pattern block missing ${missing.join(", ")}`,
      );
      resetCurrent();
      return;
    }

    let trigger;
    try {
      trigger = new RegExp(current.trigger);
    } catch (error) {
      warnPattern(
        sourceLabel,
        current.lineNumber,
        `skipping invalid regex "${current.trigger}": ${error.message}`,
      );
      resetCurrent();
      return;
    }

    const suggestions = [...current.suggestions];
    if (current.type === "generic") {
      patterns.generic.push({
        trigger,
        suggestion: suggestions,
      });
    } else if (current.type === "variableDependent") {
      patterns.variableDependent.push({
        trigger,
        builder: ({ variableName, match }) =>
          suggestions.map((line) =>
            interpolateSuggestionLine(line, variableName, match),
          ),
      });
    } else {
      warnPattern(
        sourceLabel,
        current.lineNumber,
        `skipping unknown TYPE "${current.type}"`,
      );
    }

    resetCurrent();
  }

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const directiveLine = lines[index].trimStart();
    const trimmedLine = directiveLine.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    if (trimmedLine === "---") {
      flushCurrent();
      continue;
    }

    if (!current.lineNumber) {
      current.lineNumber = lineNumber;
    }

    const trigger = readDirectiveValue(directiveLine, "TRIGGER");
    if (trigger !== null) {
      current.trigger = trigger.trim();
      continue;
    }

    const type = readDirectiveValue(directiveLine, "TYPE");
    if (type !== null) {
      current.type = type.trim();
      continue;
    }

    const suggestion = readDirectiveValue(directiveLine, "SUGGESTION");
    if (suggestion !== null) {
      current.suggestions.push(suggestion);
      continue;
    }

    warnPattern(sourceLabel, lineNumber, `ignoring unrecognized line`);
  }

  flushCurrent();
  return patterns;
}

function loadPatternsFromFile(patternsFilePath) {
  const text = fs.readFileSync(patternsFilePath, "utf8");
  return parsePatternsText(text, patternsFilePath);
}

/**
 * @returns {Patterns}
 */
function createPatterns(patternsFilePath) {
  const resolvedPatternsFilePath = getPatternsFilePath(patternsFilePath);
  try {
    return loadPatternsFromFile(resolvedPatternsFilePath);
  } catch (error) {
    console.error(
      `[FaultyAI] Could not load patterns from ${resolvedPatternsFilePath}:`,
      error,
    );
    return createEmptyPatterns();
  }
}

module.exports = {
  DEFAULT_PATTERNS_FILE,
  createPatterns,
  getPatternsFilePath,
  loadPatternsFromFile,
  parsePatternsText,
};
