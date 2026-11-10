import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [target, ...args] = process.argv.slice(2);
const statePath = process.env.INSTALLER_FIXTURE_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const current = state[target];
const query = args[0] === "plugin" && (args[1] === "list" || (args[1] === "marketplace" && args[2] === "list"));
const key = [target, ...args].join(" ");
appendFileSync(process.env.INSTALLER_FIXTURE_LOG, JSON.stringify({ target, args, query }) + "\n");
const override = state.responses[key];
if (override) {
  process.stdout.write(override.stdout || "");
  process.stderr.write(override.stderr || "");
  process.exit(override.status ?? 0);
}
if (query) {
  if (args[1] === "marketplace") {
    if (target === "omp") {
      console.log(current.marketplaces.length
        ? `Configured Marketplaces:\n\n${current.marketplaces.map((m) => `  ${m.name}  ${m.source}`).join("\n")}`
        : "No marketplaces configured\n\nAdd one with: omp plugin marketplace add <source>");
    } else console.log(JSON.stringify(current.marketplaces.map(({ declarationScopes, ...entry }) => entry)));
  } else console.log(JSON.stringify(current.plugins));
  process.exit(0);
}

const scopeArg = args.find((arg) => arg.startsWith("--scope="));
const scopeIndex = args.indexOf("--scope");
const scope = scopeArg ? scopeArg.slice("--scope=".length) : scopeIndex !== -1 ? args[scopeIndex + 1] : "user";
if (args[0] !== "plugin") throw new Error(`unexpected fixture command ${key}`);
if (args[1] === "marketplace") {
  const action = args[2];
  if (action === "add") {
    const path = args[3];
    const manifest = JSON.parse(readFileSync(join(path, ".claude-plugin", "marketplace.json"), "utf8"));
    if (manifest.name !== state.marketplace) throw new Error("wrong staged marketplace");
    current.marketplaces.push(target === "omp"
      ? { name: state.marketplace, source: path }
      : { name: state.marketplace, source: "directory", path, installLocation: path, declarationScopes: [scope] });
  } else if (action === "update") {
    const marketplace = current.marketplaces.find((m) => m.name === args[3]);
    if (!marketplace) throw new Error("missing marketplace to update");
    readFileSync(join(target === "omp" ? marketplace.source : marketplace.path, ".claude-plugin", "marketplace.json"));
  } else if (action === "remove") {
    const entry = current.marketplaces.find((m) => m.name === args[3]);
    if (target === "claude" && scopeIndex !== -1 && !entry?.declarationScopes?.includes(scope)) throw new Error(`marketplace not declared in ${scope} settings`);
    current.marketplaces = current.marketplaces.filter((m) => m.name !== args[3]);
  } else throw new Error(`unexpected fixture command ${key}`);
} else if (["install", "upgrade", "uninstall"].includes(args[1])) {
  const id = args.find((arg) => arg.includes("@"));
  if (id !== state.plugin) throw new Error(`unexpected fixture plugin ${id}`);
  const matches = (p) => p.id === id && p.scope === scope && (scope !== "project" || target === "omp" || p.projectPath === process.cwd());
  if (target === "omp") current.plugins.marketplace = current.plugins.marketplace.filter((p) => !matches(p));
  else current.plugins = current.plugins.filter((p) => !matches(p));
  if (args[1] !== "uninstall") {
    const marketplace = current.marketplaces.find((m) => m.name === state.marketplace);
    const path = target === "omp" ? marketplace.source : marketplace.path;
    const manifest = JSON.parse(readFileSync(join(path, "plugins", "pstack", ".claude-plugin", "plugin.json"), "utf8"));
    const entry = { scope, installPath: join(path, "plugins", "pstack"), version: manifest.version };
    if (target === "omp") current.plugins.marketplace.push({ id, scope, entries: [entry] });
    else current.plugins.push({ id, ...entry, enabled: true, ...(scope === "project" ? { projectPath: process.cwd() } : {}) });
  }
} else throw new Error(`unexpected fixture command ${key}`);
writeFileSync(statePath, JSON.stringify(state));
console.log(`fixture ${key}`);
