import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const requiredThemeTokens = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "selectedBg",
  "userMessageBg",
  "userMessageText",
  "customMessageBg",
  "customMessageText",
  "customMessageLabel",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode",
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validatePackage(dir, expectedName, expectedPiKey) {
  const pkgPath = join(root, "packages", dir, "package.json");
  const pkg = readJson(pkgPath);
  assert(pkg.name === expectedName, `${dir}: expected package name ${expectedName}, got ${pkg.name}`);
  assert(pkg.version, `${dir}: missing version`);
  assert(pkg.license === "MIT", `${dir}: expected MIT license`);
  assert(pkg.publishConfig?.access === "public", `${dir}: missing publishConfig.access=public`);
  assert(pkg.keywords?.includes("pi-package"), `${dir}: missing pi-package keyword`);
  assert(pkg.pi?.[expectedPiKey]?.length > 0, `${dir}: missing pi.${expectedPiKey}`);
  for (const file of ["README.md", "LICENSE"]) {
    assert(existsSync(join(root, "packages", dir, file)), `${dir}: missing ${file}`);
  }
  return pkg;
}

validatePackage("pi-theme-cyberpunk", "@codella/pi-theme-cyberpunk", "themes");
validatePackage("pi-theme-candy", "@codella/pi-theme-candy", "themes");
validatePackage("pi-plan-mode", "@codella/pi-plan-mode", "extensions");
const mcpPkg = validatePackage("pi-mcp-support", "@codella/pi-mcp-support", "extensions");
assert(mcpPkg.dependencies?.["@modelcontextprotocol/sdk"], "pi-mcp-support: missing @modelcontextprotocol/sdk dependency");

for (const path of [
  "packages/pi-plan-mode/extensions/index.ts",
  "packages/pi-plan-mode/extensions/utils.ts",
  "packages/pi-mcp-support/extensions/index.ts",
  "packages/pi-mcp-support/examples/mcp.json",
]) {
  assert(existsSync(join(root, path)), `missing ${path}`);
}

const hex = /^#[0-9a-fA-F]{6}$/;

function validateThemeFile(path, expectedName) {
  const theme = readJson(join(root, path));
  assert(theme.name === expectedName, `${path}: theme name must be ${expectedName}, got ${theme.name}`);

  const colorKeys = Object.keys(theme.colors ?? {});
  const missing = requiredThemeTokens.filter((key) => !colorKeys.includes(key));
  const extra = colorKeys.filter((key) => !requiredThemeTokens.includes(key));
  assert(missing.length === 0, `${path}: theme missing tokens: ${missing.join(", ")}`);
  assert(extra.length === 0, `${path}: theme has extra tokens: ${extra.join(", ")}`);

  const vars = new Set(Object.keys(theme.vars ?? {}));
  for (const [section, values] of Object.entries({ colors: theme.colors ?? {}, export: theme.export ?? {} })) {
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === "number") {
        assert(Number.isInteger(value) && value >= 0 && value <= 255, `${path}: ${section}.${key}: invalid 256-color value`);
      } else if (typeof value === "string") {
        assert(value === "" || hex.test(value) || vars.has(value), `${path}: ${section}.${key}: invalid color/reference ${value}`);
      } else {
        throw new Error(`${path}: ${section}.${key}: invalid color value type`);
      }
    }
  }
}

validateThemeFile("packages/pi-theme-cyberpunk/themes/cyberpunk.json", "cyberpunk");
validateThemeFile("packages/pi-theme-candy/themes/candy.json", "candy");

console.log("Validation OK");
