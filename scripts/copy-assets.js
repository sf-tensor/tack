const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "src", "bun", "assets");
const dest = path.join(__dirname, "..", "dist", "bun", "assets");

if (!fs.existsSync(src)) {
  console.warn(`[tack] No assets directory found at ${src}`);
  process.exit(0);
}

fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });
