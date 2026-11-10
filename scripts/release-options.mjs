import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

export const spawnCommand = process.platform === "win32" ? createRequire(import.meta.url)("cross-spawn").sync : spawnSync;
const valueOptions = new Set([
  "access", "otp", "tag", "registry", "userconfig", "globalconfig", "cache", "cafile", "ca", "cert", "key",
  "https-proxy", "proxy", "noproxy", "fetch-retries", "fetch-retry-factor", "fetch-retry-mintimeout",
  "fetch-retry-maxtimeout", "fetch-timeout", "loglevel", "logs-dir", "provenance-file", "auth-type",
  "scope", "local-address", "maxsockets",
]);
const booleanOptions = new Set([
  "dry-run", "provenance", "ignore-scripts", "foreground-scripts", "json", "strict-ssl", "offline",
  "prefer-offline", "prefer-online", "timing", "force", "color", "progress", "audit",
]);
const publishOnly = new Set(["access", "otp", "tag", "dry-run", "provenance", "provenance-file"]);

export function parseReleaseArgs(args) {
  const options = { npmArgs: [], registryArgs: [] };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!/^--[^=]+(?:=.*)?$/.test(argument)) throw new Error("Use named options only; a release cannot accept an npm publish target");
    const separator = argument.indexOf("=");
    const key = argument.slice(2, separator < 0 ? undefined : separator);
    let value = separator < 0 ? undefined : argument.slice(separator + 1);
    const takeValue = () => {
      if (value === undefined) value = args[++index];
      if (!value || value.startsWith("-") || /[\0\r\n]/.test(value)) throw new Error(`--${key} requires a nonempty value that does not begin with '-'`);
      return value;
    };
    if (key === "ref" || key === "name") {
      options[key] = takeValue();
      continue;
    }
    if (key === "check-registry") {
      if (value !== undefined) throw new Error("--check-registry does not take a value");
      options.checkRegistry = true;
      continue;
    }
    const positiveKey = key.replace(/^no-/, "");
    if (["ws", "iwr"].includes(positiveKey) || ["workspace", "workspaces", "include-workspace-root", "prefix", "global", "location", "usage", "help", "version"].some((blocked) => blocked.startsWith(positiveKey))) {
      throw new Error("Options that redirect npm to another project or command are not supported");
    }
    if (valueOptions.has(key)) takeValue();
    else if (booleanOptions.has(positiveKey)) {
      if (value === undefined && /^(true|false)$/.test(args[index + 1] || "")) value = args[++index];
      if (value !== undefined && value !== "true" && value !== "false") throw new Error(`--${key} requires true or false`);
    } else if (value === undefined && args[index + 1] && !args[index + 1].startsWith("-")) {
      throw new Error("Use --option=value for additional npm configuration options; positional publish targets are not allowed");
    }
    const option = value === undefined ? `--${key}` : `--${key}=${value}`;
    options.npmArgs.push(option);
    if (!publishOnly.has(positiveKey)) options.registryArgs.push(option);
  }
  return options;
}
