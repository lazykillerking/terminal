#!/usr/bin/env node

/**
 * Generate terminal_fs/.index.json from the actual file system structure.
 * Run this whenever you add/remove files in terminal_fs/
 * Usage: node generate-index.js
 */

const fs = require('fs');
const path = require('path');

const TERMINAL_FS_DIR = path.join(__dirname, 'terminal_fs');
const INDEX_FILE = path.join(TERMINAL_FS_DIR, '.index.json');

function buildIndex(dirPath) {
  const node = {
    type: 'dir',
    children: {}
  };

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      // Skip .index.json itself and hidden files
      if (entry.name.startsWith('.')) continue;
      
      const fullPath = path.join(dirPath, entry.name);
      
      if (entry.isDirectory()) {
        node.children[entry.name] = buildIndex(fullPath);
      } else {
        node.children[entry.name] = { type: 'file' };
      }
    }
  } catch (err) {
    console.error(`Error reading directory ${dirPath}:`, err.message);
  }

  return node;
}

try {
  const index = buildIndex(TERMINAL_FS_DIR);
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
  console.log(`✓ Generated ${INDEX_FILE}`);
  console.log(`Root has ${Object.keys(index.children).length} entries`);

  // also update bundle file for file:// convenience
  try {
    const bundlePath = path.join(__dirname, 'terminal_fs.bundle.js');
    // compute files map
    function collectFiles(dir, prefix = '') {
      let out = {};
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        const key = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) {
          Object.assign(out, collectFiles(full, key));
        } else {
          out[key] = fs.readFileSync(full, 'utf-8');
        }
      }
      return out;
    }
    const filesMap = collectFiles(TERMINAL_FS_DIR);
    // rewrite bundle from scratch (more reliable than regex surgery)
    const bundleContent = `window.TERMINAL_FS_BUNDLE = {
  rootName: "terminal_fs",
  index: ${JSON.stringify(index, null, 2)},
  files: ${JSON.stringify(filesMap, null, 2)}
};\n`;
    fs.writeFileSync(bundlePath, bundleContent);
    console.log(`✓ Updated ${bundlePath} with new index and file contents`);
  } catch (err) {
    console.error('Error updating bundle:', err.message);
  }
} catch (err) {
  console.error('Error generating index:', err.message);
  process.exit(1);
}
