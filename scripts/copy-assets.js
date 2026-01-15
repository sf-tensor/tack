const fs = require("fs");
const path = require("path");

const assetDirs = [
  {
    name: "bun assets",
    src: path.join(__dirname, "..", "src", "bun", "assets"),
    dest: path.join(__dirname, "..", "dist", "bun", "assets")
  },
  {
    name: "app assets",
    src: path.join(__dirname, "..", "src", "app", "assets"),
    dest: path.join(__dirname, "..", "dist", "app", "assets")
  },
  {
    name: "sql executor lambda",
    src: path.join(__dirname, "..", "src", "database", "sql-executor-lambda"),
    dest: path.join(__dirname, "..", "dist", "database", "sql-executor-lambda")
  }
];

for (const asset of assetDirs) {
  if (!fs.existsSync(asset.src)) {
    console.warn(`[tack] No ${asset.name} directory found at ${asset.src}`);
    continue;
  }

  fs.mkdirSync(asset.dest, { recursive: true });
  fs.cpSync(asset.src, asset.dest, { recursive: true });
}
