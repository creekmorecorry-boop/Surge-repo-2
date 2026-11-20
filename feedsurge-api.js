/*
 * FEEDSURGE backend entry point for Render.
 *
 * The existing backend implementation remains in feedsurge-app/feedsurge-api.js.
 * This root entry point lets Render start it from the repository root and
 * enforces the agreed minimum registration age of 16 without changing any
 * frontend files or duplicating the backend implementation.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");

const implementationPath = path.join(
  __dirname,
  "feedsurge-app",
  "feedsurge-api.js"
);

if (!fs.existsSync(implementationPath)) {
  console.error("FEEDSURGE backend implementation is missing:", implementationPath);
  process.exit(1);
}

let source = fs.readFileSync(implementationPath, "utf8");
const oldAgeRule = "if (age < 13)";
const newAgeRule = "if (age < 16)";
const occurrences = source.split(oldAgeRule).length - 1;

if (occurrences !== 1) {
  console.error(
    "FEEDSURGE startup stopped: expected exactly one existing 13+ age check, found",
    occurrences,
    "The backend source may have changed; refusing to start without verifying the age gate."
  );
  process.exit(1);
}

source = source.replace(oldAgeRule, newAgeRule);

const backendModule = new Module(implementationPath, module);
backendModule.filename = implementationPath;
backendModule.paths = Module._nodeModulePaths(path.dirname(implementationPath));
backendModule._compile(source, implementationPath);
