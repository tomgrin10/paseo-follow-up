// Preloaded into every harness process (harnessEnv puts it on NODE_OPTIONS): os.hostname() answers HARNESS_HOSTNAME.
// Paseo labels its host with os.hostname() (the phone header, server_info, the web UI); a render must never show the
// real machine's name. It runs before any ES module imports node:os, and syncBuiltinESMExports covers one that did.
const os = require("node:os");
const name = process.env.HARNESS_HOSTNAME || "dev-box";
os.hostname = () => name;
require("node:module").syncBuiltinESMExports();
