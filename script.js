const input = document.getElementById("commandInput");
const output = document.getElementById("output");
const prompt = document.getElementById("prompt");
const terminal = document.getElementById("terminal");
const inputLine = document.querySelector(".input-line");
const cursor = document.getElementById("cursor");
const cursorMeasure = document.getElementById("cursorMeasure");

const history = [];
let historyIndex = 0;
let draftInput = "";

const user = "lkk";
const DEFAULT_ROOT = "terminal_fs";

const MOUNT_PASSWORDS = {
  terminal_fs: "lkk-root",
};

const KNOWN_COMMANDS = [
  "help",
  "whoami",
  "about",
  "clear",
  "echo",
  "mount",
  "ls",
  "cd",
  "pwd",
  "cat",
  "tree",
];

let rootName = DEFAULT_ROOT;
let rootIndex = null;
let cwd = [];
let bundledFiles = {};

function syncCursorPosition() {
  const text = input.value.length ? input.value : " ";
  cursorMeasure.textContent = text;
  const measuredWidth = cursorMeasure.offsetWidth + 1;
  const inputStart = input.offsetLeft;
  const maxLeft = inputStart + input.clientWidth - cursor.offsetWidth;
  const left = Math.min(inputStart + measuredWidth, Math.max(inputStart, maxLeft));
  cursor.style.left = `${left}px`;
}

function focusInput() {
  input.focus({ preventScroll: true });
  input.setSelectionRange(input.value.length, input.value.length);
}

function scrollOutputToBottom() {
  terminal.scrollTop = terminal.scrollHeight;
}

function renderPrompt() {
  const path = cwd.length ? `~/${cwd.join("/")}` : "~";
  prompt.textContent = `${user}@terminal:${path}$`;
  syncCursorPosition();
}

function printLine(text = "", type = "normal") {
  const div = document.createElement("div");
  div.className = `line line-${type}`;
  div.textContent = text;
  output.appendChild(div);
}

function printCommandLine(promptText, rawValue) {
  const div = document.createElement("div");
  div.className = "line line-command";
  div.innerHTML = `<span class="line-prompt">${escapeHtml(promptText)}</span> ${escapeHtml(rawValue)}`;
  output.appendChild(div);
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseInput(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return { cmd: "", args: [] };
  const parts = trimmed.split(/\s+/);
  return { cmd: parts[0], args: parts.slice(1) };
}

function normalizeParts(parts) {
  const normalized = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      normalized.pop();
    } else {
      normalized.push(part);
    }
  }
  return normalized;
}

function resolvePath(pathArg = "") {
  if (!pathArg || pathArg === ".") return [...cwd];
  if (pathArg === "~") return [];

  let base = [...cwd];
  let raw = pathArg;

  if (raw.startsWith("~/")) {
    base = [];
    raw = raw.slice(2);
  } else if (raw.startsWith("/")) {
    base = [];
    raw = raw.slice(1);
  }

  return normalizeParts(base.concat(raw.split("/")));
}

function getNodeByPath(pathParts) {
  if (!rootIndex) return null;
  let node = rootIndex;
  for (const part of pathParts) {
    if (!node || node.type !== "dir") return null;
    node = node.children[part];
  }
  return node || null;
}

function listDirectoryEntries(dirNode) {
  return Object.keys(dirNode.children)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      kind: dirNode.children[name].type === "dir" ? "directory" : "file",
    }));
}

function buildTreeLines(node, name = ".", prefix = "", includeSelf = true, lines = []) {
  if (includeSelf) {
    lines.push(`${prefix}${name}`);
  }

  if (!node || node.type !== "dir") return lines;

  const entries = listDirectoryEntries(node);
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const branch = isLast ? "`-- " : "|-- ";
    const extension = isLast ? "    " : "|   ";
    lines.push(`${prefix}${branch}${entry.name}`);

    if (entry.kind === "directory") {
      buildTreeLines(node.children[entry.name], "", `${prefix}${extension}`, false, lines);
    }
  }
  return lines;
}

function suggestFromSet(word, options) {
  if (!word) return [];
  const lower = word.toLowerCase();
  const starts = options.filter((o) => o.toLowerCase().startsWith(lower));
  if (starts.length) return starts.slice(0, 6);
  const includes = options.filter((o) => o.toLowerCase().includes(lower));
  return includes.slice(0, 6);
}

function suggestPathNames(baseParts) {
  const node = getNodeByPath(baseParts);
  if (!node || node.type !== "dir") return [];
  return listDirectoryEntries(node).map((e) => e.name);
}

function buildFileUrl(pathParts) {
  if (!pathParts.length) return `${rootName}/`;
  return `${rootName}/${pathParts.join("/")}`;
}

async function loadRootIndex(targetRootName) {
  const bundle = window.TERMINAL_FS_BUNDLE;
  if (
    bundle &&
    bundle.rootName === targetRootName &&
    bundle.index &&
    typeof bundle.files === "object"
  ) {
    rootName = targetRootName;
    rootIndex = bundle.index;
    bundledFiles = bundle.files;
    cwd = [];
    renderPrompt();
    return true;
  }

  try {
    const res = await fetch(`${targetRootName}/.index.json`, { cache: "no-store" });
    if (!res.ok) return false;
    const index = await res.json();
    rootName = targetRootName;
    rootIndex = index;
    bundledFiles = {};
    cwd = [];
    renderPrompt();
    return true;
  } catch (_) {
    return false;
  }
}

async function runCommand(cmd, args) {
  if (cmd === "help") {
    return {
      text: `Available commands:
help
whoami
about
clear
echo
mount <folder> <password>
ls [path]
cd [path]
pwd
cat <file>
tree [path]`,
      type: "info",
    };
  }

  if (cmd === "whoami") return { text: user };
  if (cmd === "about") return { text: "LazyKillerKing Terminal v3.1.2" };
  if (cmd === "clear") {
    output.innerHTML = "";
    return { text: "" };
  }
  if (cmd === "echo") return { text: args.join(" ") };

  if (cmd === "mount") {
    if (!args.length) {
      return { text: `Mounted root: ${rootName}`, type: "info" };
    }

    if (args.length < 2) {
      return { text: "mount: usage: mount <folder> <password>", type: "error" };
    }

    const folder = args[0];
    const password = args[1];
    if (!Object.prototype.hasOwnProperty.call(MOUNT_PASSWORDS, folder)) {
      return { text: "mount: access denied", type: "error" };
    }
    if (MOUNT_PASSWORDS[folder] !== password) {
      return { text: "mount: invalid password", type: "error" };
    }

    const mounted = await loadRootIndex(folder);
    if (!mounted) {
      return { text: `mount: unable to load '${folder}'`, type: "error" };
    }
    return { text: `Mounted: ${folder}`, type: "success" };
  }

  if (!rootIndex) {
    return { text: "Filesystem unavailable.", type: "error" };
  }

  if (cmd === "pwd") {
    return { text: `/${cwd.join("/")}` || "/" };
  }

  if (cmd === "ls") {
    const target = args[0] || ".";
    const parts = resolvePath(target);
    const node = getNodeByPath(parts);
    if (!node) {
      return { text: `ls: cannot access '${target}': No such file or directory`, type: "error" };
    }
    if (node.type === "file") {
      const name = parts[parts.length - 1] || target;
      return { text: name };
    }
    const rendered = listDirectoryEntries(node)
      .map((entry) => (entry.kind === "directory" ? `${entry.name}/` : entry.name))
      .join("  ");
    return { text: rendered };
  }

  if (cmd === "cd") {
    const target = args[0] || "~";
    const parts = resolvePath(target);
    const node = getNodeByPath(parts);

    if (!node) {
      const suggestionPool = suggestPathNames(cwd);
      const leaf = target.split("/").filter(Boolean).slice(-1)[0] || target;
      const suggestions = suggestFromSet(leaf, suggestionPool);
      const suffix = suggestions.length ? `\nDid you mean: ${suggestions.join(", ")} ?` : "";
      return { text: `cd: ${target}: No such file or directory${suffix}`, type: "error" };
    }
    if (node.type !== "dir") {
      return { text: `cd: ${target}: Not a directory`, type: "error" };
    }

    cwd = parts;
    renderPrompt();
    return { text: "" };
  }

  if (cmd === "cat") {
    if (!args[0]) return { text: "cat: missing file operand", type: "error" };
    const target = args[0];
    const parts = resolvePath(target);
    const node = getNodeByPath(parts);

    if (!node) return { text: `cat: ${target}: No such file or directory`, type: "error" };
    if (node.type !== "file") return { text: `cat: ${target}: Is a directory`, type: "error" };

    const relativePath = parts.join("/");
    if (Object.prototype.hasOwnProperty.call(bundledFiles, relativePath)) {
      return { text: bundledFiles[relativePath] || "(empty file)" };
    }

    try {
      const res = await fetch(buildFileUrl(parts), { cache: "no-store" });
      if (!res.ok) {
        return { text: `cat: ${target}: Unable to read file`, type: "error" };
      }
      const text = await res.text();
      return { text: text || "(empty file)" };
    } catch (_) {
      return { text: `cat: ${target}: Unable to read file`, type: "error" };
    }
  }

  if (cmd === "tree") {
    const target = args[0] || ".";
    const parts = resolvePath(target);
    const node = getNodeByPath(parts);
    if (!node) return { text: `tree: ${target}: No such file or directory`, type: "error" };
    if (node.type !== "dir") return { text: `tree: ${target}: Not a directory`, type: "error" };

    const rootLabel = target === "." ? "." : parts[parts.length - 1] || "/";
    const lines = buildTreeLines(node, rootLabel);
    return { text: lines.join("\n") };
  }

  const suggestions = suggestFromSet(cmd, KNOWN_COMMANDS);
  const suggestionText = suggestions.length ? `\nDid you mean: ${suggestions.join(", ")} ?` : "";
  return { text: `Command not found: ${cmd}${suggestionText}`, type: "error" };
}

async function handleEnter() {
  const wasNearBottom =
    terminal.scrollHeight - (terminal.scrollTop + terminal.clientHeight) < 16;

  const rawValue = input.value;
  const value = rawValue.trim();
  const { cmd, args } = parseInput(rawValue);

  if (value !== "") history.push(value);
  historyIndex = history.length;
  draftInput = "";

  printCommandLine(prompt.textContent, rawValue);

  if (value) {
    try {
      const result = await runCommand(cmd, args);
      if (result && result.text) {
        printLine(result.text, result.type || "normal");
      }
    } catch (error) {
      printLine(`error: ${error.message || String(error)}`, "error");
    }
  }

  if (wasNearBottom) {
    scrollOutputToBottom();
  }
  input.value = "";
  syncCursorPosition();
  focusInput();
}

async function tryAutocomplete() {
  const value = input.value.trim();
  const parts = value.split(/\s+/).filter(Boolean);

  if (parts.length <= 1) {
    const cmd = parts[0] || "";
    const matches = suggestFromSet(cmd, KNOWN_COMMANDS);
    if (matches.length === 1) {
      input.value = `${matches[0]} `;
    } else if (matches.length > 1) {
      printLine(matches.join("   "), "suggestion");
    }
    return;
  }

  const last = parts[parts.length - 1];
  const baseForSuggestions = last.includes("/")
    ? resolvePath(last.split("/").slice(0, -1).join("/"))
    : [...cwd];
  const prefix = last.includes("/") ? last.split("/").slice(-1)[0] : last;
  const names = suggestPathNames(baseForSuggestions);
  const matches = suggestFromSet(prefix, names);

  if (matches.length === 1) {
    const root = last.includes("/") ? `${last.split("/").slice(0, -1).join("/")}/` : "";
    parts[parts.length - 1] = `${root}${matches[0]}`;
    input.value = `${parts.join(" ")} `;
  } else if (matches.length > 1) {
    printLine(matches.join("   "), "suggestion");
  }
}

input.addEventListener("keydown", async (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    await handleEnter();
    return;
  }

  if (e.key === "Tab") {
    e.preventDefault();
    await tryAutocomplete();
    return;
  }

  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (history.length === 0) return;
    if (historyIndex === history.length) draftInput = input.value;
    if (historyIndex > 0) {
      historyIndex -= 1;
      input.value = history[historyIndex];
      syncCursorPosition();
    }
    return;
  }

  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (history.length === 0) return;
    if (historyIndex < history.length - 1) {
      historyIndex += 1;
      input.value = history[historyIndex];
    } else {
      historyIndex = history.length;
      input.value = draftInput;
    }
    syncCursorPosition();
  }
});

window.addEventListener("focus", focusInput);
window.addEventListener("resize", syncCursorPosition);
document.addEventListener("pointerdown", (event) => {
  if (event.target !== input) {
    setTimeout(focusInput, 0);
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) focusInput();
});
input.addEventListener("input", syncCursorPosition);

async function boot() {
  renderPrompt();
  syncCursorPosition();
  focusInput();

  const ok = await loadRootIndex(DEFAULT_ROOT);
  if (!ok) {
    printLine(`Could not auto-mount '${DEFAULT_ROOT}'.`, "error");
  }
}

boot();
