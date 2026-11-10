const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const { resolve } = require("node:path");

const rename = fs.renameSync;
let failed = false;
fs.renameSync = (source, destination) => {
  if (resolve(destination) === process.env.INSTALLER_RENAME_TARGET && (!failed || process.env.INSTALLER_RESTORE_FAILURE === "1")) {
    failed = true;
    const error = new Error("fixture rename denied");
    error.code = "EACCES";
    throw error;
  }
  return rename(source, destination);
};
syncBuiltinESMExports();
