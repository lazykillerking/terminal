const input = document.getElementById("commandInput");
const output = document.getElementById("output");
const prompt = document.getElementById("prompt");
const terminal = document.getElementById("terminal");
const inputLine = document.querySelector(".input-line");
const cursor = document.getElementById("cursor");
const cursorMeasure = document.getElementById("cursorMeasure");
const matrixFx = document.getElementById("matrixFx");
inputLine.style.display = "none";

// Command history state for ArrowUp/ArrowDown navigation.
const history = [];
let historyIndex = 0;
let draftInput = "";

const user = "lkk";
const DEFAULT_ROOT = "terminal_fs";
const TERMINAL_VERSION = "4.6.5";

// Per-folder mount password hashes (SHA-256) for root switching with `mount`.
const MOUNT_PASSWORD_HASHES = {
  terminal_fs: "076c9567f26d4cd5acbc8574e91d8ff80adb450601b3ff16686e8c5ced9c86d2",
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
let bootInProgress = false;
let unlockGlitchPlayed = false;
let soundEnabled = false;
let keyAudioContext = null;

const OVERLAY_FS_KEY = "terminal.overlay.fs";
const OVERLAY_CACHE_KEY = "terminal.overlay.cache";

const BOOT_LINE_DELAY_MS = 36;
const BOOT_CLEAR_PAUSE_MS = 120;
const BOOT_STEPS = [
  { label: "Initializing kernel subsystems", type: "success" },
  { label: "Mounting terminal_fs volume", type: "success" },
  { label: "Loading user profile", type: "success" },
  { label: "Starting interactive session for lkk", type: "success" },
];
const BOOT_FOLLOWUP_LABELS = [
  "Loading command registry",
  "Hydrating virtual file index",
  "Applying terminal profile",
  "Starting I/O multiplexer",
  "Calibrating cursor renderer",
  "Finalizing security context",
];
const MATRIX_FX_DURATION_MS = 2000;
const PAGE_LOAD_FADE_MS = 400;
const MATRIX_FX_MAX_OPACITY = 1;
const MATRIX_FX_COLUMN_REVEAL_MS = 900;
const MATRIX_FX_FONT_SIZE = 22;
const MATRIX_FX_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$#*+-";
const BOOT_ASCII = [
  " _______                  _             _ ",
  "|__   __|                (_)           | |",
  "   | | ___ _ __ _ __ ___  _ _ __   __ _| |",
  "   | |/ _ \\ '__| '_ ` _ \\| | '_ \\ / _` | |",
  "   | |  __/ |  | | | | | | | | | | (_| | |",
  "   |_|\\___|_|  |_| |_| |_|_|_| |_|\\__,_|_|",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function saveOverlayFS() {
  try {
    const state = {
      rootName,
      rootIndex,
      bundledFiles,
      timestamp: Date.now(),
    };
    localStorage.setItem(OVERLAY_FS_KEY, JSON.stringify(state));
  } catch (e) {
    console.error("Failed to save overlay filesystem:", e);
  }
}

function loadOverlayFS() {
  try {
    const stored = localStorage.getItem(OVERLAY_FS_KEY);
    if (stored) {
      const state = JSON.parse(stored);
      return {
        rootName: state.rootName,
        rootIndex: state.rootIndex,
        bundledFiles: state.bundledFiles,
      };
    }
  } catch (e) {
    console.error("Failed to load overlay filesystem:", e);
  }
  return null;
}

function clearOverlayFS() {
  try {
    localStorage.removeItem(OVERLAY_FS_KEY);
  } catch (e) {
    console.error("Failed to clear overlay filesystem:", e);
  }
}

function runTerminalPageLoadFade() {
  if (!terminal) return;
  terminal.style.opacity = "0";
  
  // Force a reflow to ensure the opacity: 0 state is applied
  void terminal.offsetHeight;
  
  terminal.style.transition = `opacity ${PAGE_LOAD_FADE_MS}ms ease`;
  terminal.style.opacity = "1";
}

function runUnlockGlitchOnce() {
  if (unlockGlitchPlayed) return false;
  unlockGlitchPlayed = true;
  terminal.classList.remove("unlock-glitch");
  // Force reflow so animation restarts reliably when class toggles.
  void terminal.offsetWidth;
  terminal.classList.add("unlock-glitch");
  setTimeout(() => {
    terminal.classList.remove("unlock-glitch");
  }, 650);
  return true;
}

function getKeyAudioContext() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!keyAudioContext) keyAudioContext = new AudioCtx();
  return keyAudioContext;
}

function shouldPlayKeySound(event) {
  if (!soundEnabled) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  const silentKeys = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);
  return !silentKeys.has(event.key);
}

function playKeySound(event) {
  if (!shouldPlayKeySound(event)) return;

  const ctx = getKeyAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();

  const isCharacter = event.key.length === 1;
  osc.type = "square";
  osc.frequency.setValueAtTime(isCharacter ? 165 : 125, now);
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(isCharacter ? 1950 : 1400, now);
  filter.Q.setValueAtTime(1.2, now);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.02, now + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + 0.04);
}

function runStartupMatrixFade() {
  if (!matrixFx) return Promise.resolve();

  const ctx = matrixFx.getContext("2d");
  if (!ctx) return Promise.resolve();

  let rafId = 0;
  let width = 0;
  let height = 0;
  let columns = 0;
  let drops = [];
  let speeds = [];

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    matrixFx.width = Math.floor(width * dpr);
    matrixFx.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    columns = Math.max(1, Math.floor(width / MATRIX_FX_FONT_SIZE));
    drops = Array.from({ length: columns }, () => -(Math.random() * 24));
    speeds = Array.from({ length: columns }, () => 0.22 + Math.random() * 0.38);
  }

  resizeCanvas();
  matrixFx.style.opacity = String(MATRIX_FX_MAX_OPACITY);
  const startedAt = performance.now();
  const fadeStartAt = MATRIX_FX_DURATION_MS * 0.55;

  return new Promise((resolve) => {
    let finished = false;
    let hardStopTimer = 0;

    function finish() {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(rafId);
      clearTimeout(hardStopTimer);
      matrixFx.style.opacity = "0";
      ctx.clearRect(0, 0, width, height);
      window.removeEventListener("resize", resizeCanvas);
      resolve();
    }

    function frame(now) {
      const elapsed = now - startedAt;
      if (elapsed >= MATRIX_FX_DURATION_MS) {
        finish();
        return;
      }

    const revealProgress = Math.min(1, elapsed / MATRIX_FX_COLUMN_REVEAL_MS);
    const activeColumns = Math.max(1, Math.floor(columns * revealProgress));
    const fadeProgress = elapsed <= fadeStartAt ? 1 : 1 - (elapsed - fadeStartAt) / (MATRIX_FX_DURATION_MS - fadeStartAt);
    const visibility = Math.max(0, Math.min(1, fadeProgress));

    matrixFx.style.opacity = String(MATRIX_FX_MAX_OPACITY * visibility);
    ctx.fillStyle = "rgba(0, 0, 0, 0.14)";
    ctx.fillRect(0, 0, width, height);
    ctx.font = `${MATRIX_FX_FONT_SIZE}px "Ubuntu Mono", monospace`;
    ctx.textBaseline = "top";
    ctx.fillStyle = `rgba(115, 210, 22, ${0.55 * visibility})`;

    for (let col = 0; col < activeColumns; col += 1) {
      const x = col * MATRIX_FX_FONT_SIZE;
      const y = drops[col] * MATRIX_FX_FONT_SIZE;
      const char = MATRIX_FX_CHARS[(Math.floor(elapsed / 40) + col) % MATRIX_FX_CHARS.length];
      ctx.fillText(char, x, y);
      drops[col] += speeds[col];
      if (y > height + MATRIX_FX_FONT_SIZE) {
        drops[col] = -(Math.random() * 20);
      }
    }

      rafId = requestAnimationFrame(frame);
    }

    window.addEventListener("resize", resizeCanvas);
    rafId = requestAnimationFrame(frame);
    // Live environments can throttle RAF heavily; ensure boot never stalls waiting.
    hardStopTimer = window.setTimeout(finish, MATRIX_FX_DURATION_MS + 250);
  });
}

// Moves the fake block cursor so it tracks the typed text width.
function syncCursorPosition() {
  const cursorPos = input.selectionStart;
  const inputStart = input.offsetLeft;
  
  if (cursorPos === 0) {
    // Cursor at the start of input
    cursor.style.left = `${inputStart}px`;
  } else {
    // Cursor somewhere in the text
    const textBeforeCursor = input.value.substring(0, cursorPos);
    cursorMeasure.textContent = textBeforeCursor;
    const measuredWidth = cursorMeasure.offsetWidth;
    const maxLeft = inputStart + input.clientWidth - cursor.offsetWidth;
    const left = Math.min(inputStart + measuredWidth, Math.max(inputStart, maxLeft));
    cursor.style.left = `${left}px`;
  }
}

function focusInput() {
  input.focus({ preventScroll: true });
  input.setSelectionRange(input.value.length, input.value.length);
}

function scrollOutputToBottom() {
  terminal.scrollTo({
    top: terminal.scrollHeight,
    behavior: bootInProgress ? "auto" : "smooth",
  });
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

function printLsLine(entries = []) {
  const div = document.createElement("div");
  div.className = "line";

  entries.forEach((entry, index) => {
    const span = document.createElement("span");
    span.className = `ls-entry ls-entry-${entry.kind || "file"}`;
    span.textContent = entry.label || entry.name;
    div.appendChild(span);

    if (index < entries.length - 1) {
      div.appendChild(document.createTextNode("  "));
    }
  });

  output.appendChild(div);
}

function printCommandResult(result) {
  if (!result || !result.text) return;
  if (Array.isArray(result.entries) && result.entries.length) {
    printLsLine(result.entries);
    return;
  }
  printLine(result.text, result.type || "normal");
}

function printBootStatusLine(label, ok = true, type = "success") {
  const div = document.createElement("div");
  div.className = `line line-${type}`;
  const tag = ok ? " OK " : "FAIL";
  div.innerHTML = `<span class="boot-status-tag">[${tag}]</span> ${escapeHtml(label)}...`;
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

async function verifyMountPassword(folder, password) {
  const configured = MOUNT_PASSWORD_HASHES[folder];
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

async function describeNodeType(path, node) {
  if (!node) return "cannot open";
  if (node.type === "dir") return "directory";
  
  const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "";
  
  // Get file content to check magic bytes
  let content = null;
  try {
    if (node.type === "file") {
      const parts = resolvePath(path);
      const read = await readFileText(parts, path);
      if (read.ok) {
        content = read.text;
      }
    }
  } catch (e) {
    // Continue with extension-based detection
  }
  
  // Magic byte detection (convert to hex for comparison)
  if (content !== null && content.length > 0) {
    const bytes = new TextEncoder().encode(content.substring(0, 8));
    
    // PNG: 89 50 4E 47
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
      return "PNG image data";
    }
    
    // ZIP: 50 4B 03 04 or 50 4B 05 06
    if (bytes[0] === 0x50 && bytes[1] === 0x4B && (bytes[2] === 0x03 || bytes[2] === 0x05)) {
      return "Zip archive data";
    }
    
    // GZIP: 1F 8B
    if (bytes[0] === 0x1F && bytes[1] === 0x8B) {
      return "gzip compressed data";
    }
    
    // TAR: check for "ustar" at offset 257
    if (content.length > 265 && content.substring(257, 262) === "ustar") {
      return "tar archive";
    }
    
    // ELF: 7F 45 4C 46
    if (bytes[0] === 0x7F && bytes[1] === 0x45 && bytes[2] === 0x4C && bytes[3] === 0x46) {
      return "ELF executable";
    }
    
    // JPEG: FF D8 FF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
      return "JPEG image data";
    }
    
    // GIF: 47 49 46
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
      return "GIF image data";
    }
    
    // PDF: 25 50 44 46 (%)
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
      return "PDF document";
    }
    
    // Check if content is ASCII/UTF-8 readable
    const isASCII = /^[\x00-\x7F]*$/.test(content);
    const isUTF8 = /^[\x00-\xFF]*$/.test(content);
    const isPrintable = /^[\x20-\x7E\n\r\t]*$/.test(content.substring(0, 200));
  }
  
  // Extension-based detection
  if (["txt", "md", "log", "csv", "cfg", "conf", "config"].includes(ext)) return "ASCII text";
  if (["html", "htm", "xml", "svg"].includes(ext)) return "HTML/XML document";
  if (["js", "ts", "jsx", "tsx"].includes(ext)) return "JavaScript/TypeScript source";
  if (["json"].includes(ext)) return "JSON data";
  if (["css"].includes(ext)) return "CSS stylesheet";
  if (["py", "py3"].includes(ext)) return "Python script";
  if (["sh", "bash"].includes(ext)) return "bash script";
  if (["c", "cpp", "cc", "h"].includes(ext)) return "C/C++ source";
  if (["java"].includes(ext)) return "Java source";
  if (["rb"].includes(ext)) return "Ruby script";
  if (["go"].includes(ext)) return "Go source";
  if (["rs"].includes(ext)) return "Rust source";
  if (["zip", "rar", "7z"].includes(ext)) return "compressed archive";
  if (["tar", "tar.gz", "tgz"].includes(ext)) return "tar archive";
  if (["gz", "gzip"].includes(ext)) return "gzip compressed";
  if (["png"].includes(ext)) return "PNG image";
  if (["jpg", "jpeg"].includes(ext)) return "JPEG image";
  if (["gif"].includes(ext)) return "GIF image";
  if (["bmp"].includes(ext)) return "BMP image";
  if (["svg"].includes(ext)) return "SVG image";
  if (["pdf"].includes(ext)) return "PDF document";
  if (["mp3", "wav", "flac", "aac"].includes(ext)) return "audio file";
  if (["mp4", "avi", "mkv", "mov", "webm"].includes(ext)) return "video file";
  
  return "regular file";
}

function splitTargetPath(pathArg) {
  const parts = resolvePath(pathArg);
  if (parts.length === 0) return { error: `${pathArg || "/"}: invalid target` };
  return {
    parts,
    parentParts: parts.slice(0, -1),
    name: parts[parts.length - 1],
    key: parts.join("/"),
  };
}

function getDirOrNull(parts) {
  const node = getNodeByPath(parts);
  if (!node || node.type !== "dir") return null;
  return node;
}

function removeFilePayloadRecursive(parts, node) {
  if (!node) return;
  if (node.type === "file") {
    delete bundledFiles[parts.join("/")];
    return;
  }
  Object.entries(node.children).forEach(([name, child]) => {
    removeFilePayloadRecursive(parts.concat(name), child);
  });
}

function cloneNodeDeep(node) {
  if (node.type === "file") return { type: "file" };
  const children = {};
  Object.entries(node.children).forEach(([name, child]) => {
    children[name] = cloneNodeDeep(child);
  });
  return { type: "dir", children };
}

function copyFilePayloadRecursive(srcParts, dstParts, node) {
  if (node.type === "file") {
    const srcKey = srcParts.join("/");
    const dstKey = dstParts.join("/");
    if (Object.prototype.hasOwnProperty.call(bundledFiles, srcKey)) {
      bundledFiles[dstKey] = bundledFiles[srcKey];
    } else {
      bundledFiles[dstKey] = "";
    }
    return;
  }
  Object.entries(node.children).forEach(([name, child]) => {
    copyFilePayloadRecursive(srcParts.concat(name), dstParts.concat(name), child);
  });
}

async function readFileText(parts, displayPath) {
  const key = parts.join("/");
  if (Object.prototype.hasOwnProperty.call(bundledFiles, key)) {
    return { ok: true, text: bundledFiles[key] ?? "" };
  }

  try {
    const res = await fetch(buildFileUrl(parts), { cache: "no-store" });
    if (!res.ok) return { ok: false, error: `${displayPath}: Unable to read file` };
    const text = await res.text();
    bundledFiles[key] = text;
    return { ok: true, text };
  } catch (_) {
    return { ok: false, error: `${displayPath}: Unable to read file` };
  }
}

// Helper to probe server for a file and add to index if found
async function ensureFileNode(parts) {
  let node = getNodeByPath(parts);
  if (node) return node;
  // Skip server probing for file:// protocol - it won't work
  if (window.location.protocol === "file:") return null;
  
  // attempt HEAD request to check existence (only for http/https)
  try {
    const url = buildFileUrl(parts);
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    if (res.ok) {
      // create missing directories
      let parent = rootIndex;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (!parent.children[p]) {
          parent.children[p] = { type: "dir", children: {} };
        }
        parent = parent.children[p];
        if (parent.type !== "dir") return null;
      }
      const name = parts[parts.length - 1];
      parent.children[name] = { type: "file" };
      return parent.children[name];
    }
  } catch (_) {}
  return null;
}

// similar helper for directories
async function ensureDirNode(parts) {
  let node = getNodeByPath(parts);
  if (node) return node;
  // Skip server probing for file:// protocol - it won't work
  if (window.location.protocol === "file:") return null;
  
  try {
    const url = buildFileUrl(parts) + "/";
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    if (res.ok) {
      // create missing dir path
      let parent = rootIndex;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (!parent.children[p]) {
          parent.children[p] = { type: "dir", children: {} };
        }
        parent = parent.children[p];
        if (parent.type !== "dir") return null;
      }
      const name = parts[parts.length - 1];
      parent.children[name] = { type: "dir", children: {} };
      return parent.children[name];
    }
  } catch (_) {}
  return null;
}

// Augment a directory node by fetching server directory listing (if available)
async function augmentDirectoryFromServer(parts) {
  const node = getNodeByPath(parts);
  if (!node || node.type !== "dir" || node._augmented) return;
  
  // Skip for file:// protocol - directory listing won't work
  if (window.location.protocol === "file:") {
    node._augmented = true;
    return;
  }
  
  const url = buildFileUrl(parts) + "/";
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok && res.headers.get("content-type")?.includes("text/html")) {
      const html = await res.text();
      const regex = /<a\s+href="([^"]+)"/g;
      let m;
      while ((m = regex.exec(html)) !== null) {
        let name = m[1];
        if (name === "../" || name === "/") continue;
        if (name.endsWith("/")) name = name.slice(0, -1);
        if (!node.children[name]) {
          node.children[name] = { type: "file" };
        }
      }
    }
  } catch (_) {}
  node._augmented = true;
}

async function readRedirectInput(pathArg) {
  if (!rootIndex) return { ok: false, error: "Filesystem unavailable." };
  const parts = resolvePath(pathArg);
  let node = getNodeByPath(parts);
  if (!node) {
    node = await ensureFileNode(parts);
    if (node && !rootIndex) rootIndex = { type: 'dir', children: {} };
  }
  if (!node) return { ok: false, error: `${pathArg}: No such file or directory` };
  if (node.type !== "file") return { ok: false, error: `${pathArg}: Is a directory` };
  const read = await readFileText(parts, pathArg);
  if (!read.ok) return { ok: false, error: read.error };
  return { ok: true, text: read.text ?? "" };
}

async function writeRedirectOutput(pathArg, text, append = false) {
  if (!rootIndex) return { ok: false, error: "Filesystem unavailable." };

  const target = splitTargetPath(pathArg);
  if (target.error) return { ok: false, error: target.error };
  const parent = getDirOrNull(target.parentParts);
  if (!parent) return { ok: false, error: `${pathArg}: No such file or directory` };

  const existing = parent.children[target.name];
  if (existing && existing.type === "dir") return { ok: false, error: `${pathArg}: Is a directory` };
  if (!existing) parent.children[target.name] = { type: "file" };

  let nextText = text;
  if (append) {
    if (!Object.prototype.hasOwnProperty.call(bundledFiles, target.key)) {
      bundledFiles[target.key] = "";
    }
    const read = await readFileText(target.parts, pathArg);
    if (!read.ok) return { ok: false, error: read.error };
    const current = read.text ?? "";
    if (!current || !text) {
      nextText = current + text;
    } else {
      nextText = `${current}${current.endsWith("\n") ? "" : "\n"}${text}`;
    }
  }

  bundledFiles[target.key] = nextText;
  saveOverlayFS();
  return { ok: true };
}

function tokenizeCommandLine(raw) {
  const tokens = [];
  let current = "";
  let quote = null;

  const pushCurrent = () => {
    if (current.length) {
      tokens.push(current);
      current = "";
    }
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    if (ch === "|") {
      pushCurrent();
      tokens.push("|");
      continue;
    }

    if (ch === "<") {
      pushCurrent();
      tokens.push("<");
      continue;
    }

    if (ch === ">") {
      pushCurrent();
      if (raw[i + 1] === ">") {
        tokens.push(">>");
        i += 1;
      } else {
        tokens.push(">");
      }
      continue;
    }

    current += ch;
  }

  if (quote) {
    return { ok: false, error: "syntax error: unmatched quote" };
  }

  pushCurrent();
  return { ok: true, tokens };
}

function parseCommandLine(raw) {
  const tokenized = tokenizeCommandLine(raw);
  if (!tokenized.ok) return tokenized;
  if (!tokenized.tokens.length) return { ok: true, segments: [] };

  const segments = [];
  let segment = { cmd: "", args: [], stdinPath: "", stdoutPath: "", append: false };
  let expectingPathFor = "";

  const finishSegment = () => {
    if (expectingPathFor) return { ok: false, error: "syntax error near redirection" };
    if (!segment.cmd) return { ok: false, error: "syntax error near pipe" };
    segments.push(segment);
    segment = { cmd: "", args: [], stdinPath: "", stdoutPath: "", append: false };
    return { ok: true };
  };

  for (const token of tokenized.tokens) {
    if (token === "|") {
      const done = finishSegment();
      if (!done.ok) return done;
      continue;
    }

    if (token === "<" || token === ">" || token === ">>") {
      if (expectingPathFor) return { ok: false, error: "syntax error near redirection" };
      expectingPathFor = token;
      continue;
    }

    if (expectingPathFor) {
      if (expectingPathFor === "<") {
        segment.stdinPath = token;
      } else {
        segment.stdoutPath = token;
        segment.append = expectingPathFor === ">>";
      }
      expectingPathFor = "";
      continue;
    }

    if (!segment.cmd) {
      segment.cmd = token;
    } else {
      segment.args.push(token);
    }
  }

  const done = finishSegment();
  if (!done.ok) return done;
  return { ok: true, segments };
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

function isLikelyExecutable(name) {
  return /\.(sh|bash|zsh|ps1|bat|cmd|exe|com|py|js|mjs|cjs)$/i.test(name);
}

function getDisplayKind(entry) {
  if (entry.kind === "directory") return "directory";
  return isLikelyExecutable(entry.name) ? "executable" : "file";
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

async function suggestPathNames(baseParts) {
  const node = getNodeByPath(baseParts);
  if (!node || node.type !== "dir") return [];
  await augmentDirectoryFromServer(baseParts);
  return listDirectoryEntries(node).map((e) => e.name);
}

function buildFileUrl(pathParts) {
  if (!pathParts.length) return `${rootName}/`;
  return `${rootName}/${pathParts.join("/")}`;
}

// merge overlay index into the base index, preferring overlay entries when conflicts arise
function mergeIndex(baseNode, overlayNode) {
  for (const name of Object.keys(overlayNode.children || {})) {
    const overChild = overlayNode.children[name];
    const baseChild = baseNode.children[name];
    if (!baseChild) {
      // new node added by overlay
      baseNode.children[name] = overChild;
    } else if (overChild.type === "dir" && baseChild.type === "dir") {
      // both directories: recurse
      mergeIndex(baseChild, overChild);
    } else {
      // overlay replaces base (file or differing type)
      baseNode.children[name] = overChild;
    }
  }
}

// refresh the current root index by reloading base data and merging the overlay
// preserves the existing cwd so commands don't get kicked to '/'.
async function refreshIndex() {
  if (!rootName) return false;
  const oldCwd = cwd.slice();
  const ok = await loadRootIndex(rootName);
  cwd = oldCwd;
  renderPrompt();
  return ok;
}

// Load filesystem index:
// 1) try hosted .index.json first (file:// or http)
// 2) fall back to embedded bundle
// If an overlay exists for the root, merge its changes on top of
// whatever base index we loaded so that new files are visible.
async function loadRootIndex(targetRootName) {
  // load base index from server or bundle
  let baseIndex = null;
  let baseBundledFiles = {};

  const protocol = window.location.protocol;
  if (protocol === "file:") {
    try {
      const res = await fetch(`${targetRootName}/.index.json`, { cache: "no-store" });
      if (res.ok) {
        baseIndex = await res.json();
        baseBundledFiles = {};
      }
    } catch (_) {
      // ignore and try bundle next
    }
  }

  if (!baseIndex) {
    const bundle = window.TERMINAL_FS_BUNDLE;
    if (
      bundle &&
      bundle.rootName === targetRootName &&
      bundle.index &&
      typeof bundle.files === "object"
    ) {
      baseIndex = bundle.index;
      baseBundledFiles = bundle.files;
    }
  }

  if (!baseIndex) {
    return false;
  }

  // merge overlay if present
  const overlay = loadOverlayFS();
  if (overlay && overlay.rootName === targetRootName) {
    mergeIndex(baseIndex, overlay.rootIndex);
    baseBundledFiles = { ...baseBundledFiles, ...overlay.bundledFiles };
  }

  rootName = targetRootName;
  rootIndex = baseIndex;
  bundledFiles = baseBundledFiles;
  cwd = [];
  renderPrompt();
  return true;
}

function registerCommands() {
  registerCommand({
    name: "help",
    description: "List available commands",
    async run() {
      const rows = getCommandNames()
        .filter((name) => !commandRegistry.get(name)?.hidden)
        .map((name) => {
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
      return { text: `LazyKillerKing Terminal v${TERMINAL_VERSION}` };
    },
  });

  registerCommand({
    name: "neofetch",
    description: "Display system information with ASCII banner",
    async run() {
      const lines = [];
      BOOT_ASCII.forEach((line) => lines.push(line));
      lines.push(""); // Empty line for spacing
      lines.push(`Terminal: LazyKillerKing v${TERMINAL_VERSION}`);
      lines.push(`User: ${user}`);
      lines.push(`Hostname: lkk-terminal`);
      lines.push(`Shell: terminal.sh`);
      lines.push(`OS: Browser-based Virtual FS`);
      return { text: lines.join("\n"), type: "info" };
    },
  });

  registerCommand({
    name: "sound",
    description: "Toggle key sound (use: sound on|off)",
    async run(args) {
      const value = (args[0] || "").toLowerCase();
      if (!value) {
        return { text: `sound: ${soundEnabled ? "on" : "off"} (usage: sound <on|off>)`, type: "info" };
      }
      if (value === "on") {
        soundEnabled = true;
        return { text: "sound: on", type: "success" };
      }
      if (value === "off") {
        soundEnabled = false;
        return { text: "sound: off", type: "info" };
      }
      return { text: "sound: usage: sound <on|off>", type: "error" };
    },
  });

  registerCommand({
    name: "unlock",
    hidden: true,
    async run() {
      const triggered = runUnlockGlitchOnce();
      if (!triggered) {
        return { text: "unlock: already triggered this session (refresh to replay)", type: "info" };
      }
      return { text: "" };
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
    name: "history",
    description: "Show command history",
    async run(args) {
      if (history.length === 0) {
        return { text: "No command history", type: "info" };
      }
      const numbered = history.map((cmd, idx) => `${idx + 1}  ${cmd}`).join("\n");
      return { text: numbered };
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
    name: "exit",
    description: "Close the terminal",
    async run() {
      setTimeout(() => {
        window.close();
        // If close fails (HTTP/HTTPS restriction), try navigating to the browser home page
        if (!window.closed) {
          // common home page URIs; browser will use whichever it supports
          const homeCandidates = ['about:home', 'about:newtab', 'chrome://newtab'];
          for (const uri of homeCandidates) {
            try {
              window.location = uri;
              return;
            } catch (_) {}
          }
          // if the browser won't accept a home URI, try a public page
          try {
            window.location = 'https://www.google.com/';
            return;
          } catch (_) {}
          // all else fails, fall back to blank
          window.location = 'about:blank';
        }
      }, 500);
      return { text: "Goodbye!" };
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
    name: "reset",
    description: "Reset filesystem to initial state",
    async run() {
      clearOverlayFS();
      const ok = await loadRootIndex(DEFAULT_ROOT);
      if (!ok) {
        return { text: "reset: failed to reload filesystem", type: "error" };
      }
      
      // Clear output and show welcome screen
      output.innerHTML = "";
      BOOT_ASCII.forEach((line) => printLine(line, "info"));
      printLine("");
      printLine(`Welcome to Terminal v${TERMINAL_VERSION}`, "success");
      printLine(`Session ready. Type 'help' to begin.`, "info");
      printLine("");
      scrollOutputToBottom();
      
      return { text: "" };
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
      let node = getNodeByPath(parts);
      if (!node) {
        node = await ensureFileNode(parts);
      }
      if (!node) {
        return { text: `ls: cannot access '${target}': No such file or directory`, type: "error" };
      }
      if (node.type === "file") {
        const name = parts[parts.length - 1] || target;
        return {
          text: name,
          entries: [{ label: name, kind: isLikelyExecutable(name) ? "executable" : "file" }],
        };
      }
      // if directory, attempt to augment listing from server (skip on file:// protocol)
      if (window.location.protocol !== "file:") {
        await augmentDirectoryFromServer(parts);
      }

      const entries = listDirectoryEntries(node).filter((entry) => showAll || !entry.name.startsWith("."));
      const printable = entries.map((entry) => {
        const displayKind = getDisplayKind(entry);
        const label = entry.kind === "directory" ? `${entry.name}/` : entry.name;
        return { label, kind: displayKind };
      });
      if (showAll) {
        printable.unshift({ label: "..", kind: "directory" });
        printable.unshift({ label: ".", kind: "directory" });
      }
      return {
        text: printable.map((entry) => entry.label).join("  "),
        entries: printable,
      };
    },
  });

  registerCommand({
    name: "cd",
    description: "Change directory",
    async run(args) {
      if (!rootIndex) return { text: "Filesystem unavailable.", type: "error" };

      const target = args[0] || "~";
      const parts = resolvePath(target);
      let node = getNodeByPath(parts);
      if (!node) {
        node = await ensureDirNode(parts);
      }

      if (!node) {
        const suggestionPool = await suggestPathNames(cwd);
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
    description: "Print file contents (or stdin)",
    async run(args, ctx) {
      if (!rootIndex) return { text: "Filesystem unavailable.", type: "error" };

      if (!args.length) {
        return { text: ctx.stdin || "" };
      }

      const chunks = [];
      for (const target of args) {
        const parts = resolvePath(target);
        let node = getNodeByPath(parts);
        if (!node) {
          node = await ensureFileNode(parts);
        }

        if (!node) return { text: `cat: ${target}: No such file or directory`, type: "error" };
        if (node.type !== "file") return { text: `cat: ${target}: Is a directory`, type: "error" };

        const relativePath = parts.join("/");
        if (Object.prototype.hasOwnProperty.call(bundledFiles, relativePath)) {
          chunks.push(bundledFiles[relativePath] ?? "");
          continue;
        }

        try {
          const res = await fetch(buildFileUrl(parts), { cache: "no-store" });
          if (!res.ok) return { text: `cat: ${target}: Unable to read file`, type: "error" };
          const text = await res.text();
          chunks.push(text);
        } catch (_) {
          return { text: `cat: ${target}: Unable to read file`, type: "error" };
        }
      }

      return { text: chunks.join("\n") };
    },
  });

  registerCommand({
    name: "touch",
    description: "Create empty file or update file timestamp",
    async run(args) {
      if (!rootIndex) return { text: "Filesystem unavailable.", type: "error" };
      if (!args[0]) return { text: "touch: missing file operand", type: "error" };

      const target = splitTargetPath(args[0]);
      if (target.error) return { text: `touch: ${target.error}`, type: "error" };
      const parent = getDirOrNull(target.parentParts);
      if (!parent) return { text: `touch: cannot touch '${args[0]}': No such file or directory`, type: "error" };

      const existing = parent.children[target.name];
      if (existing && existing.type === "dir") {
        return { text: `touch: cannot touch '${args[0]}': Is a directory`, type: "error" };
      }
      if (!existing) parent.children[target.name] = { type: "file" };
      if (!Object.prototype.hasOwnProperty.call(bundledFiles, target.key)) bundledFiles[target.key] = "";
      saveOverlayFS();
      return { text: "" };
    },
  });

  registerCommand({
    name: "mkdir",
    description: "Create directory",
    async run(args) {
      if (!rootIndex) return { text: "Filesystem unavailable.", type: "error" };
      if (!args[0]) return { text: "mkdir: missing operand", type: "error" };

      const target = splitTargetPath(args[0]);
      if (target.error) return { text: `mkdir: ${target.error}`, type: "error" };
      const parent = getDirOrNull(target.parentParts);
      if (!parent) return { text: `mkdir: cannot create directory '${args[0]}': No such file or directory`, type: "error" };
      if (parent.children[target.name]) {
        return { text: `mkdir: cannot create directory '${args[0]}': File exists`, type: "error" };
      }
      parent.children[target.name] = { type: "dir", children: {} };
      saveOverlayFS();
      return { text: "" };
    },
  });

  registerCommand({
    name: "rm",
    description: "Remove file (-r for directories)",
    async run(args) {
      if (!rootIndex) return { text: "Filesystem unavailable.", type: "error" };
      if (!args[0]) return { text: "rm: missing operand", type: "error" };

      const recursive = args.includes("-r") || args.includes("-rf");
      const targetArg = args.find((arg) => !arg.startsWith("-"));
      if (!targetArg) return { text: "rm: missing operand", type: "error" };

      const target = splitTargetPath(targetArg);
      if (target.error) return { text: `rm: ${target.error}`, type: "error" };
      let parent = getDirOrNull(target.parentParts);
      if (!parent || !parent.children[target.name]) {
        // maybe the file exists on server
        await ensureFileNode(target.parts);
        parent = getDirOrNull(target.parentParts);
      }
      if (!parent || !parent.children[target.name]) {
        return { text: `rm: cannot remove '${targetArg}': No such file or directory`, type: "error" };
      }

      const node = parent.children[target.name];
      if (node.type === "dir" && !recursive) {
        return { text: `rm: cannot remove '${targetArg}': Is a directory`, type: "error" };
      }

      removeFilePayloadRecursive(target.parts, node);
      delete parent.children[target.name];
      saveOverlayFS();
      return { text: "" };
    },
  });

  registerCommand({
    name: "rmdir",
    description: "Remove empty directory",
    async run(args) {
      if (!rootIndex) return { text: "Filesystem unavailable.", type: "error" };
      if (!args[0]) return { text: "rmdir: missing operand", type: "error" };

      const target = splitTargetPath(args[0]);
      if (target.error) return { text: `rmdir: ${target.error}`, type: "error" };
      const parent = getDirOrNull(target.parentParts);
      if (!parent || !parent.children[target.name]) {
        return { text: `rmdir: failed to remove '${args[0]}': No such file or directory`, type: "error" };
      }
      const node = parent.children[target.name];
      if (node.type !== "dir") return { text: `rmdir: failed to remove '${args[0]}': Not a directory`, type: "error" };
      if (Object.keys(node.children).length > 0) {
        return { text: `rmdir: failed to remove '${args[0]}': Directory not empty`, type: "error" };
      }
      delete parent.children[target.name];
      saveOverlayFS();
      return { text: "" };
    },
  });

  registerCommand({
    name: "mv",
    description: "Move/rename file or directory",
    async run(args) {
      if (!rootIndex) return { text: "Filesystem unavailable.", type: "error" };
      if (args.length < 2) return { text: "mv: missing file operand", type: "error" };

      const src = splitTargetPath(args[0]);
      const dst = splitTargetPath(args[1]);
      if (src.error) return { text: `mv: ${src.error}`, type: "error" };
      if (dst.error) return { text: `mv: ${dst.error}`, type: "error" };

      let srcParent = getDirOrNull(src.parentParts);
      if (!srcParent || !srcParent.children[src.name]) {
        await ensureFileNode(src.parts);
        srcParent = getDirOrNull(src.parentParts);
      }
      const dstParent = getDirOrNull(dst.parentParts);
      if (!srcParent || !srcParent.children[src.name]) {
        return { text: `mv: cannot stat '${args[0]}': No such file or directory`, type: "error" };
      }
      if (!dstParent) return { text: `mv: cannot move to '${args[1]}': No such file or directory`, type: "error" };
      if (dstParent.children[dst.name]) return { text: `mv: cannot move to '${args[1]}': File exists`, type: "error" };

      const node = srcParent.children[src.name];
      dstParent.children[dst.name] = node;
      delete srcParent.children[src.name];

      if (node.type === "file") {
        if (Object.prototype.hasOwnProperty.call(bundledFiles, src.key)) {
          bundledFiles[dst.key] = bundledFiles[src.key];
          delete bundledFiles[src.key];
        } else {
          const read = await readFileText(src.parts, args[0]);
          if (read.ok) {
            bundledFiles[dst.key] = read.text;
            delete bundledFiles[src.key];
          }
        }
      } else {
        copyFilePayloadRecursive(src.parts, dst.parts, node);
        removeFilePayloadRecursive(src.parts, node);
      }
      saveOverlayFS();
      return { text: "" };
    },
  });

  registerCommand({
    name: "cp",
    description: "Copy file (-r for directories)",
    async run(args) {
      if (!rootIndex) return { text: "Filesystem unavailable.", type: "error" };
      if (args.length < 2) return { text: "cp: missing file operand", type: "error" };

      const recursive = args.includes("-r") || args.includes("-R");
      const plain = args.filter((arg) => !arg.startsWith("-"));
      if (plain.length < 2) return { text: "cp: missing destination file operand", type: "error" };

      const src = splitTargetPath(plain[0]);
      const dst = splitTargetPath(plain[1]);
      if (src.error) return { text: `cp: ${src.error}`, type: "error" };
      if (dst.error) return { text: `cp: ${dst.error}`, type: "error" };

      let srcParent = getDirOrNull(src.parentParts);
      if (!srcParent) {
        // maybe directory doesn't exist locally; try creating via server
        await ensureFileNode(src.parentParts.concat([src.name]));
        srcParent = getDirOrNull(src.parentParts);
      }
      if (!srcParent || !srcParent.children[src.name]) {
        // try fetching file directly
        const fileNode = await ensureFileNode(src.parentParts.concat([src.name]));
        if (fileNode) {
          srcParent = getDirOrNull(src.parentParts);
        }
      }
      const dstParent = getDirOrNull(dst.parentParts);
      if (!srcParent || !srcParent.children[src.name]) {
        return { text: `cp: cannot stat '${plain[0]}': No such file or directory`, type: "error" };
      }
      if (!dstParent) return { text: `cp: cannot copy to '${plain[1]}': No such file or directory`, type: "error" };
      if (dstParent.children[dst.name]) return { text: `cp: cannot copy to '${plain[1]}': File exists`, type: "error" };

      const node = srcParent.children[src.name];
      if (node.type === "dir" && !recursive) {
        return { text: `cp: -r not specified; omitting directory '${plain[0]}'`, type: "error" };
      }

      dstParent.children[dst.name] = cloneNodeDeep(node);
      copyFilePayloadRecursive(src.parts, dst.parts, node);
      saveOverlayFS();
      return { text: "" };
    },
  });

  registerCommand({
    name: "head",
    description: "Print first lines of file",
    async run(args) {
      if (!rootIndex) return { text: "Filesystem unavailable.", type: "error" };
      if (!args[0]) return { text: "head: missing file operand", type: "error" };

      let lineCount = 10;
      let fileArg = args[0];
      if ((args[0] === "-n" || args[0] === "--lines") && args[1] && args[2]) {
        lineCount = Math.max(1, Number.parseInt(args[1], 10) || 10);
        fileArg = args[2];
      }

      const target = splitTargetPath(fileArg);
      if (target.error) return { text: `head: ${target.error}`, type: "error" };
      let node = getNodeByPath(target.parts);
      if (!node) {
        node = await ensureFileNode(target.parts);
      }
      if (!node) return { text: `head: cannot open '${fileArg}': No such file or directory`, type: "error" };
      if (node.type !== "file") return { text: `head: error reading '${fileArg}': Is a directory`, type: "error" };

      const read = await readFileText(target.parts, fileArg);
      if (!read.ok) return { text: `head: ${read.error}`, type: "error" };
      return { text: read.text.split("\n").slice(0, lineCount).join("\n") };
    },
  });

  registerCommand({
    name: "tail",
    description: "Print last lines of file",
    async run(args) {
      if (!rootIndex) return { text: "Filesystem unavailable.", type: "error" };
      if (!args[0]) return { text: "tail: missing file operand", type: "error" };

      let lineCount = 10;
      let fileArg = args[0];
      if ((args[0] === "-n" || args[0] === "--lines") && args[1] && args[2]) {
        lineCount = Math.max(1, Number.parseInt(args[1], 10) || 10);
        fileArg = args[2];
      }

      const target = splitTargetPath(fileArg);
      if (target.error) return { text: `tail: ${target.error}`, type: "error" };
      let node = getNodeByPath(target.parts);
      if (!node) {
        node = await ensureFileNode(target.parts);
      }
      if (!node) return { text: `tail: cannot open '${fileArg}': No such file or directory`, type: "error" };
      if (node.type !== "file") return { text: `tail: error reading '${fileArg}': Is a directory`, type: "error" };

      const read = await readFileText(target.parts, fileArg);
      if (!read.ok) return { text: `tail: ${read.error}`, type: "error" };
      const lines = read.text.split("\n");
      return { text: lines.slice(Math.max(0, lines.length - lineCount)).join("\n") };
    },
  });

  registerCommand({
    name: "less",
    description: "View file content",
    async run(args) {
      if (!rootIndex) return { text: "Filesystem unavailable.", type: "error" };
      if (!args[0]) return { text: "less: missing file operand", type: "error" };

      const target = splitTargetPath(args[0]);
      if (target.error) return { text: `less: ${target.error}`, type: "error" };
      let node = getNodeByPath(target.parts);
      if (!node) {
        node = await ensureFileNode(target.parts);
      }
      if (!node) return { text: `less: cannot open '${args[0]}': No such file or directory`, type: "error" };
      if (node.type !== "file") return { text: `less: ${args[0]}: Is a directory`, type: "error" };

      const read = await readFileText(target.parts, args[0]);
      if (!read.ok) return { text: `less: ${read.error}`, type: "error" };
      return { text: `${read.text}\n(END)` };
    },
  });

  registerCommand({
    name: "grep",
    description: "Search text in file or stdin",
    async run(args, ctx) {
      if (!rootIndex) return { text: "Filesystem unavailable.", type: "error" };
      if (!args[0]) return { text: "grep: usage: grep [-n] <pattern> [file...]", type: "error" };

      const lineNumbers = args.includes("-n");
      const plain = args.filter((arg) => arg !== "-n");
      const pattern = plain[0];
      const files = plain.slice(1);
      if (!pattern) return { text: "grep: usage: grep [-n] <pattern> [file...]", type: "error" };

      const results = [];
      if (files.length === 0) {
        const source = String(ctx.stdin || "");
        source.split("\n").forEach((line, idx) => {
          if (!line.includes(pattern)) return;
          const num = lineNumbers ? `${idx + 1}:` : "";
          results.push(`${num}${line}`);
        });
        return { text: results.join("\n") };
      }

      for (const fileArg of files) {
        const target = splitTargetPath(fileArg);
        if (target.error) {
          results.push(`grep: ${fileArg}: invalid path`);
          continue;
        }

        let node = getNodeByPath(target.parts);
        if (!node) {
          node = await ensureFileNode(target.parts);
        }
        if (!node) {
          results.push(`grep: ${fileArg}: No such file or directory`);
          continue;
        }
        if (node.type !== "file") {
          results.push(`grep: ${fileArg}: Is a directory`);
          continue;
        }

        const read = await readFileText(target.parts, fileArg);
        if (!read.ok) {
          results.push(`grep: ${read.error}`);
          continue;
        }

        const lines = read.text.split("\n");
        lines.forEach((line, idx) => {
          if (!line.includes(pattern)) return;
          const prefix = files.length > 1 ? `${fileArg}:` : "";
          const num = lineNumbers ? `${idx + 1}:` : "";
          results.push(`${prefix}${num}${line}`);
        });
      }

      return { text: results.join("\n") };
    },
  });

  registerCommand({
    name: "tree",
    description: "Display directory tree",
    async run(args) {
      if (!rootIndex) return { text: "Filesystem unavailable.", type: "error" };

      const target = args[0] || ".";
      const parts = resolvePath(target);
      // try to ensure the target directory exists (server probe)
      let node = getNodeByPath(parts);
      if (!node) {
        node = await ensureDirNode(parts);
      }
      if (!node) return { text: `tree: ${target}: No such file or directory`, type: "error" };
      if (node.type !== "dir") return { text: `tree: ${target}: Not a directory`, type: "error" };

      // augment directories recursively so server files are included (skip on file:// protocol)
      async function walkAndAugment(pathParts, dirNode) {
        if (window.location.protocol !== "file:") {
          await augmentDirectoryFromServer(pathParts);
        }
        for (const name of Object.keys(dirNode.children)) {
          const child = dirNode.children[name];
          if (child.type === "dir") {
            await walkAndAugment(pathParts.concat(name), child);
          }
        }
      }
      await walkAndAugment(parts, node);

      const rootLabel = target === "." ? "." : parts[parts.length - 1] || "/";
      const lines = buildTreeLines(node, rootLabel);
      return { text: lines.join("\n") };
    },
  });

  registerCommand({
    name: "refresh",
    description: "Reload base filesystem index (keeps your changes)",
    async run() {
      if (!rootName) return { text: "Filesystem unavailable.", type: "error" };
      const ok = await refreshIndex();
      if (ok) return { text: "Filesystem index refreshed." };
      return { text: "refresh: failed to reload base index", type: "error" };
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
      const desc = await describeNodeType(target, node);
      return { text: `${target}: ${desc}` };
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
      if (!Object.prototype.hasOwnProperty.call(MOUNT_PASSWORD_HASHES, folder)) {
        return { text: "mount: access denied", type: "error" };
      }
      const validMountPassword = await verifyMountPassword(folder, password);
      if (!validMountPassword) {
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
async function runCommand(cmd, args, context = { elevated: false, stdin: "" }) {
  const resolvedName = resolveCommandName(cmd);
  if (!resolvedName) {
    const suggestions = suggestFromSet(cmd, [...getCommandNames(), ...commandAliases.keys()]);
    const suggestionText = suggestions.length ? `\nDid you mean: ${suggestions.join(", ")} ?` : "";
    return { text: `Command not found: ${cmd}${suggestionText}`, type: "error" };
  }

  const entry = commandRegistry.get(resolvedName);
  return entry.run(args, context);
}

async function runCommandLine(raw, context = { elevated: false, stdin: "" }) {
  const parsed = parseCommandLine(raw);
  if (!parsed.ok) return { text: parsed.error, type: "error" };
  if (!parsed.segments.length) return { text: "" };

  let stdinText = context.stdin || "";
  let lastOutput = "";
  let lastType = "normal";
  let lastEntries = null;

  for (const segment of parsed.segments) {
    if (segment.stdinPath) {
      const redirectedIn = await readRedirectInput(segment.stdinPath);
      if (!redirectedIn.ok) return { text: redirectedIn.error, type: "error" };
      stdinText = redirectedIn.text;
    }

    const result = await runCommand(segment.cmd, segment.args, {
      elevated: context.elevated,
      stdin: stdinText,
    });
    if (result && result.type === "error") return result;

    let stdoutText = result?.text ?? "";
    lastType = result?.type || "normal";
    lastEntries = Array.isArray(result?.entries) ? result.entries : null;

    if (segment.stdoutPath) {
      const redirectedOut = await writeRedirectOutput(segment.stdoutPath, stdoutText, segment.append);
      if (!redirectedOut.ok) return { text: redirectedOut.error, type: "error" };
      stdoutText = "";
      lastEntries = null;
    }

    stdinText = stdoutText;
    lastOutput = stdoutText;
  }

  return { text: lastOutput, type: lastType, entries: lastEntries };
}

// Executes one command line submit cycle:
// capture history -> print command -> run -> print result.
async function handleEnter() {
  if (bootInProgress) return;

  // Auto-follow output only if the user was already reading latest lines.
  const wasNearBottom =
    terminal.scrollHeight - (terminal.scrollTop + terminal.clientHeight) < 16;

  const rawValue = input.value;
  const value = rawValue.trim();

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
      const commandLine = pendingSudo.commandLine;
      pendingSudo = null;
      stopSecretInput();
      const result = await runCommandLine(commandLine, { elevated: true, stdin: "" });
      if (result && result.text) printCommandResult(result);
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
      const result = await runCommandLine(rawValue, { elevated: false, stdin: "" });
      if (result && result.text) {
        printCommandResult(result);
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

function setPromptVisible(visible) {
  inputLine.style.display = visible ? "flex" : "none";
}

function getBootFillLineCount() {
  const style = getComputedStyle(document.body);
  const lineHeight = parseFloat(style.lineHeight) || 24;
  return Math.max(BOOT_STEPS.length, Math.ceil(terminal.clientHeight / lineHeight) + 2);
}

function getBootStatusLineByIndex(index) {
  if (index < BOOT_STEPS.length) {
    const step = BOOT_STEPS[index];
    return { label: step.label, ok: true, type: step.type };
  }
  const label = BOOT_FOLLOWUP_LABELS[(index - BOOT_STEPS.length) % BOOT_FOLLOWUP_LABELS.length];
  return { label, ok: true, type: "success" };
}

async function renderBootSequence() {
  bootInProgress = true;
  setPromptVisible(false);

  printLine(`terminal/${TERMINAL_VERSION} boot manager`, "info");
  printLine("");
  scrollOutputToBottom();

  const bootLines = getBootFillLineCount();
  for (let i = 0; i < bootLines; i += 1) {
    const line = getBootStatusLineByIndex(i);
    printBootStatusLine(line.label, line.ok, line.type);
    scrollOutputToBottom();
    await sleep(BOOT_LINE_DELAY_MS);
  }

  await sleep(BOOT_CLEAR_PAUSE_MS);
  output.innerHTML = "";

  BOOT_ASCII.forEach((line) => printLine(line, "info"));
  printLine("");
  printLine(`Welcome to Terminal v${TERMINAL_VERSION}`, "success");
  printLine(`Session ready. Type 'help' to begin.`, "info");
  printLine("");
  scrollOutputToBottom();
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
      input.setSelectionRange(input.value.length, input.value.length);
      syncCursorPosition();
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
  const names = await suggestPathNames(baseForSuggestions);
  const matches = suggestFromSet(prefix, names);

  if (matches.length === 1) {
    const root = last.includes("/") ? `${last.split("/").slice(0, -1).join("/")}/` : "";
    parts[parts.length - 1] = `${root}${matches[0]}`;
    input.value = `${parts.join(" ")} `;
    input.setSelectionRange(input.value.length, input.value.length);
    syncCursorPosition();
  } else if (matches.length > 1) {
    printLine(matches.join("   "), "suggestion");
  }
}

// Keyboard controls for submit, completion, and history navigation.
input.addEventListener("keydown", async (e) => {
  playKeySound(e);

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
input.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    // Defer to allow browser to update selectionStart
    setTimeout(syncCursorPosition, 0);
  }
});
input.addEventListener("click", syncCursorPosition);
document.addEventListener("pointerdown", (event) => {
  if (event.target === input) return;

  setTimeout(() => {
    const selection = window.getSelection();
    if (selection && selection.type === "Range") return;
    focusInput();
  }, 0);
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) focusInput();
});
input.addEventListener("input", syncCursorPosition);

// Boot sequence: show startup banner, auto-mount root, then expose prompt.
async function boot() {
  registerCommands();
  await runStartupMatrixFade();
  runTerminalPageLoadFade();
  await renderBootSequence();

  const ok = await loadRootIndex(DEFAULT_ROOT);
  if (!ok) {
    printLine(`Could not auto-mount '${DEFAULT_ROOT}'.`, "error");
  }

  bootInProgress = false;
  setPromptVisible(true);
  renderPrompt();
  syncCursorPosition();
  focusInput();
}
boot();
