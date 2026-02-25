const input = document.getElementById("commandInput");
const output = document.getElementById("output");
const prompt = document.getElementById("prompt");
const terminal = document.getElementById("terminal");
const inputLine = document.querySelector(".input-line");
const cursor = document.getElementById("cursor");
const cursorMeasure = document.getElementById("cursorMeasure");

// Command history state for ArrowUp/ArrowDown navigation.
const history = [];
let historyIndex = 0;
let draftInput = "";

const user = "lkk";
const DEFAULT_ROOT = "terminal_fs";

// Simple folder-password map for future root switching with `mount`.
const MOUNT_PASSWORDS = {
  terminal_fs: "lkk-root",
};

// Command Architecture Refactor:
// Commands are registered with metadata and handlers (instead of one long if/else).
const commandRegistry = new Map();
const commandAliases = new Map();
const LOCAL_SUDO_HASH_KEY = "terminal.sudo.hash";
const SUDO_SESSION_MS = 5 * 60 * 1000;

let rootName = DEFAULT_ROOT;
let rootIndex = null;
let cwd = [];
let bundledFiles = {};
let sudoSessionUntil = 0;
let pendingSudo = null;
let pendingPasswd = null;
let promptOverride = null;

// Moves the fake block cursor so it tracks the typed text width.
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

// Prompt mirrors shell-like working directory display.
function renderPrompt() {
  const path = cwd.length ? `~/${cwd.join("/")}` : "~";
  prompt.textContent = promptOverride || `${user}@terminal:${path}$`;
  syncCursorPosition();
}

function startSecretInput(label) {
  promptOverride = label;
  input.type = "password";
  input.value = "";
  renderPrompt();
}

function stopSecretInput() {
  promptOverride = null;
  input.type = "text";
  input.value = "";
  renderPrompt();
}

function printLine(text = "", type = "normal") {
  const div = document.createElement("div");
  div.className = `line line-${type}`;
  div.textContent = text;
  output.appendChild(div);
}

// Print executed command line with escaped content to avoid HTML injection.
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

function registerCommand(config) {
  commandRegistry.set(config.name, config);
  if (Array.isArray(config.aliases)) {
    config.aliases.forEach((alias) => commandAliases.set(alias, config.name));
  }
}

function getCommandNames() {
  const names = [...commandRegistry.keys()];
  return names.sort((a, b) => a.localeCompare(b));
}

function resolveCommandName(token) {
  if (commandRegistry.has(token)) return token;
  return commandAliases.get(token) || null;
}

function hasSudoSession() {
  return Date.now() < sudoSessionUntil;
}

function setSudoSession() {
  sudoSessionUntil = Date.now() + SUDO_SESSION_MS;
}

function clearSudoSession() {
  sudoSessionUntil = 0;
}

async function sha256Hex(text) {
  const encoded = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(hashBuffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getConfiguredSudoHash() {
  const localHash = localStorage.getItem(LOCAL_SUDO_HASH_KEY);
  if (localHash) return String(localHash);
  if (window.TERMINAL_SECRET && window.TERMINAL_SECRET.sudoHash) {
    return String(window.TERMINAL_SECRET.sudoHash);
  }
  return "";
}

async function verifySudoPassword(password) {
  const configured = getConfiguredSudoHash();
  if (!configured) return false;
  const provided = await sha256Hex(password);
  return provided === configured;
}

async function setLocalSudoPassword(password) {
  const hashed = await sha256Hex(password);
  localStorage.setItem(LOCAL_SUDO_HASH_KEY, hashed);
}

function clearLocalSudoPassword() {
  localStorage.removeItem(LOCAL_SUDO_HASH_KEY);
}

function describeNodeType(path, node) {
  if (!node) return "cannot open";
  if (node.type === "dir") return "directory";
  const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "";
  if (["txt", "md", "log"].includes(ext)) return "ASCII text";
  if (["html", "htm"].includes(ext)) return "HTML document";
  if (["js"].includes(ext)) return "JavaScript source";
  if (["json"].includes(ext)) return "JSON data";
  return "regular file";
}

// Split command input into command + args with whitespace normalization.
function parseInput(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return { cmd: "", args: [] };
  const parts = trimmed.split(/\s+/);
  return { cmd: parts[0], args: parts.slice(1) };
}

// Normalize paths like ./, ../ and empty segments.
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

// Resolve input path against cwd; supports ~ and / rooted forms.
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

// Traverse the in-memory index tree and return the node at path.
function getNodeByPath(pathParts) {
  if (!rootIndex) return null;
  let node = rootIndex;
  for (const part of pathParts) {
    if (!node || node.type !== "dir") return null;
    node = node.children[part];
  }
  return node || null;
}

// Stable sorted output to keep listings deterministic.
function listDirectoryEntries(dirNode) {
  return Object.keys(dirNode.children)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      kind: dirNode.children[name].type === "dir" ? "directory" : "file",
    }));
}

// Build ASCII tree output recursively.
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

// Suggest names by prefix first, then substring fallback.
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

// Load filesystem index:
// 1) local JS bundle fallback (works on file://)
// 2) hosted .index.json (works on http/https)
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

function registerCommands() {
  registerCommand({
    name: "help",
    description: "List available commands",
    async run() {
      const rows = getCommandNames().map((name) => {
        const entry = commandRegistry.get(name);
        return `${name}${entry.description ? ` - ${entry.description}` : ""}`;
      });
      return { text: `Available commands:\n${rows.join("\n")}`, type: "info" };
    },
  });

  registerCommand({
    name: "whoami",
    description: "Show current user",
    async run(_args, ctx) {
      return { text: ctx.elevated ? "root" : user };
    },
  });

  registerCommand({
    name: "about",
    description: "Show terminal version",
    async run() {
      return { text: "LazyKillerKing Terminal v4.1.3" };
    },
  });

  registerCommand({
    name: "clear",
    description: "Clear terminal output",
    async run() {
      output.innerHTML = "";
      return { text: "" };
    },
  });

  registerCommand({
    name: "echo",
    description: "Print arguments",
    async run(args) {
      return { text: args.join(" ") };
    },
  });

  registerCommand({
    name: "hostname",
    description: "Show host name",
    async run() {
      return { text: "lkk-terminal" };
    },
  });

  registerCommand({
    name: "date",
    description: "Show current date and time",
    async run() {
      return { text: new Date().toString() };
    },
  });

  registerCommand({
    name: "uname",
    description: "Print system information",
    async run(args) {
      if (args[0] === "-a") return { text: "Linux lkk-terminal 6.1.0-ctf x86_64 GNU/Linux" };
      return { text: "Linux" };
    },
  });

  registerCommand({
    name: "id",
    description: "Print user and group IDs",
    async run(_args, ctx) {
      if (ctx.elevated) return { text: "uid=0(root) gid=0(root) groups=0(root)" };
      return { text: "uid=1000(lkk) gid=1000(lkk) groups=1000(lkk)" };
    },
  });

  registerCommand({
    name: "pwd",
    description: "Print working directory",
    async run() {
      return { text: `/${cwd.join("/")}` || "/" };
    },
  });

  registerCommand({
    name: "ls",
    description: "List directory contents",
    async run(args) {
      if (!rootIndex) return { text: "Filesystem unavailable.", type: "error" };

      const showAll = args.includes("-a");
      const targets = args.filter((arg) => arg !== "-a");
      const target = targets[0] || ".";
      const parts = resolvePath(target);
      const node = getNodeByPath(parts);
      if (!node) {
        return { text: `ls: cannot access '${target}': No such file or directory`, type: "error" };
      }
      if (node.type === "file") {
        const name = parts[parts.length - 1] || target;
        return { text: name };
      }

      const entries = listDirectoryEntries(node).filter((entry) => showAll || !entry.name.startsWith("."));
      const printable = entries.map((entry) => (entry.kind === "directory" ? `${entry.name}/` : entry.name));
      if (showAll) printable.unshift(".", "..");
      return { text: printable.join("  ") };
    },
  });

  registerCommand({
    name: "cd",
    description: "Change directory",
    async run(args) {
      if (!rootIndex) return { text: "Filesystem unavailable.", type: "error" };

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
      if (node.type !== "dir") return { text: `cd: ${target}: Not a directory`, type: "error" };

      cwd = parts;
      renderPrompt();
      return { text: "" };
    },
  });

  registerCommand({
    name: "cat",
    description: "Print file contents",
    async run(args) {
      if (!rootIndex) return { text: "Filesystem unavailable.", type: "error" };
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
        if (!res.ok) return { text: `cat: ${target}: Unable to read file`, type: "error" };
        const text = await res.text();
        return { text: text || "(empty file)" };
      } catch (_) {
        return { text: `cat: ${target}: Unable to read file`, type: "error" };
      }
    },
  });

  registerCommand({
    name: "tree",
    description: "Display directory tree",
    async run(args) {
      if (!rootIndex) return { text: "Filesystem unavailable.", type: "error" };

      const target = args[0] || ".";
      const parts = resolvePath(target);
      const node = getNodeByPath(parts);
      if (!node) return { text: `tree: ${target}: No such file or directory`, type: "error" };
      if (node.type !== "dir") return { text: `tree: ${target}: Not a directory`, type: "error" };

      const rootLabel = target === "." ? "." : parts[parts.length - 1] || "/";
      const lines = buildTreeLines(node, rootLabel);
      return { text: lines.join("\n") };
    },
  });

  registerCommand({
    name: "file",
    description: "Determine file type",
    async run(args) {
      if (!rootIndex) return { text: "Filesystem unavailable.", type: "error" };
      if (!args[0]) return { text: "file: missing operand", type: "error" };

      const target = args[0];
      const parts = resolvePath(target);
      const node = getNodeByPath(parts);
      if (!node) return { text: `file: cannot open '${target}'`, type: "error" };
      return { text: `${target}: ${describeNodeType(target, node)}` };
    },
  });

  registerCommand({
    name: "env",
    description: "Print environment-style info",
    async run(_args, ctx) {
      const env = [
        `USER=${ctx.elevated ? "root" : user}`,
        `HOME=/home/${user}`,
        `PWD=/${cwd.join("/") || ""}`.replace(/\/$/, "/"),
        "HOSTNAME=lkk-terminal",
      ];
      return { text: env.join("\n") };
    },
  });

  registerCommand({
    name: "mount",
    description: "Mount another indexed root (sudo required)",
    async run(args, ctx) {
      if (!ctx.elevated && !hasSudoSession()) {
        return { text: "mount: permission denied (try: sudo mount ...)", type: "error" };
      }
      if (!args.length) return { text: `Mounted root: ${rootName}`, type: "info" };
      if (args.length < 2) return { text: "mount: usage: mount <folder> <password>", type: "error" };

      const folder = args[0];
      const password = args[1];
      if (!Object.prototype.hasOwnProperty.call(MOUNT_PASSWORDS, folder)) {
        return { text: "mount: access denied", type: "error" };
      }
      if (MOUNT_PASSWORDS[folder] !== password) {
        return { text: "mount: invalid password", type: "error" };
      }

      const mounted = await loadRootIndex(folder);
      if (!mounted) return { text: `mount: unable to load '${folder}'`, type: "error" };
      return { text: `Mounted: ${folder}`, type: "success" };
    },
  });

  registerCommand({
    name: "sudo",
    description: "Run command as root",
    async run(args) {
      if (!getConfiguredSudoHash()) {
        return {
          text:
            "sudo: not configured (set terminal.secret.local.js or run passwd to create browser-local hash)",
          type: "error",
        };
      }
      if (!args.length) return { text: "sudo: usage: sudo [-k|-s|<command>]", type: "error" };

      if (args[0] === "-k") {
        clearSudoSession();
        return { text: "sudo: session cleared", type: "info" };
      }
      if (args[0] === "-s") {
        pendingSudo = { mode: "session" };
        startSecretInput("Password:");
        return { text: "" };
      }

      pendingSudo = { mode: "command", commandLine: args.join(" ") };
      startSecretInput("Password:");
      return { text: "" };
    },
  });

  registerCommand({
    name: "passwd",
    description: "Change sudo password (browser-local hash)",
    async run(args) {
      if (args[0] === "--use-public") {
        clearLocalSudoPassword();
        clearSudoSession();
        pendingPasswd = null;
        stopSecretInput();
        return { text: "passwd: local override removed, using public hash", type: "success" };
      }
      if (!getConfiguredSudoHash()) {
        pendingPasswd = { step: "new", newPassword: "" };
        startSecretInput("New password:");
        return { text: "" };
      }
      pendingPasswd = { step: "current", newPassword: "" };
      startSecretInput("Current password:");
      return { text: "" };
    },
  });
}

// Main command dispatcher. Returns `{ text, type }` for output rendering.
async function runCommand(cmd, args, context = { elevated: false }) {
  const resolvedName = resolveCommandName(cmd);
  if (!resolvedName) {
    const suggestions = suggestFromSet(cmd, [...getCommandNames(), ...commandAliases.keys()]);
    const suggestionText = suggestions.length ? `\nDid you mean: ${suggestions.join(", ")} ?` : "";
    return { text: `Command not found: ${cmd}${suggestionText}`, type: "error" };
  }

  const entry = commandRegistry.get(resolvedName);
  return entry.run(args, context);
}

// Executes one command line submit cycle:
// capture history -> print command -> run -> print result.
async function handleEnter() {
  // Auto-follow output only if the user was already reading latest lines.
  const wasNearBottom =
    terminal.scrollHeight - (terminal.scrollTop + terminal.clientHeight) < 16;

  const rawValue = input.value;
  const value = rawValue.trim();
  const { cmd, args } = parseInput(rawValue);

  if (pendingPasswd) {
    const entered = rawValue;

    if (pendingPasswd.step === "current") {
      const ok = await verifySudoPassword(entered);
      if (!ok) {
        printLine("passwd: current password incorrect", "error");
      } else {
        pendingPasswd.step = "new";
        startSecretInput("New password:");
      }
    } else if (pendingPasswd.step === "new") {
      if (entered.length < 4) {
        printLine("passwd: password too short (min 4 chars)", "error");
      } else {
        pendingPasswd.newPassword = entered;
        pendingPasswd.step = "confirm";
        startSecretInput("Retype new password:");
      }
    } else if (pendingPasswd.step === "confirm") {
      if (entered !== pendingPasswd.newPassword) {
        printLine("passwd: passwords do not match", "error");
        pendingPasswd.step = "new";
        startSecretInput("New password:");
      } else {
        await setLocalSudoPassword(entered);
        clearSudoSession();
        stopSecretInput();
        printLine("passwd: sudo password updated (browser-local)", "success");
        pendingPasswd = null;
      }
    }

    if (wasNearBottom) scrollOutputToBottom();
    input.value = "";
    syncCursorPosition();
    focusInput();
    return;
  }

  if (pendingSudo) {
    const ok = await verifySudoPassword(rawValue);

    if (!ok) {
      printLine("sudo: incorrect password", "error");
      startSecretInput("Password:");
    } else if (pendingSudo.mode === "session") {
      setSudoSession();
      pendingSudo = null;
      stopSecretInput();
      printLine("sudo: session active (5 min)", "success");
    } else {
      const sub = parseInput(pendingSudo.commandLine);
      pendingSudo = null;
      stopSecretInput();
      const result = await runCommand(sub.cmd, sub.args, { elevated: true });
      if (result && result.text) printLine(result.text, result.type || "normal");
    }

    if (wasNearBottom) scrollOutputToBottom();
    input.value = "";
    syncCursorPosition();
    focusInput();
    return;
  }

  if (value !== "") history.push(value);
  historyIndex = history.length;
  draftInput = "";

  printCommandLine(prompt.textContent, rawValue);

  if (value) {
    try {
      const result = await runCommand(cmd, args, { elevated: false });
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

// Tab completion for command names and current directory path entries.
async function tryAutocomplete() {
  const value = input.value.trim();
  const parts = value.split(/\s+/).filter(Boolean);

  if (parts.length <= 1) {
    const cmd = parts[0] || "";
    const matches = suggestFromSet(cmd, [...getCommandNames(), ...commandAliases.keys()]);
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

// Keyboard controls for submit, completion, and history navigation.
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

// Keep typing seamless even after external clicks or tab switches.
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

// Boot sequence: render prompt, focus input, auto-mount default root.
async function boot() {
  registerCommands();
  renderPrompt();
  syncCursorPosition();
  focusInput();

  const ok = await loadRootIndex(DEFAULT_ROOT);
  if (!ok) {
    printLine(`Could not auto-mount '${DEFAULT_ROOT}'.`, "error");
  }
}

boot();
