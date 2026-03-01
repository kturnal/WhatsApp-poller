const fs = require('node:fs');
const path = require('node:path');

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function currentMode(stats) {
  return stats.mode & 0o777;
}

function modeToOctal(mode) {
  return mode.toString(8).padStart(4, '0');
}

function applyMode(targetPath, expectedMode, stats, remediations) {
  const before = currentMode(stats);

  if (before === expectedMode) {
    return;
  }

  fs.chmodSync(targetPath, expectedMode);

  remediations.push({
    path: targetPath,
    from: modeToOctal(before),
    to: modeToOctal(expectedMode)
  });
}

function walkSecure(rootPath, remediations, dataDir) {
  const stats = fs.lstatSync(rootPath);

  if (stats.isSymbolicLink()) {
    if (rootPath === dataDir) {
      throw new Error(`DATA_DIR cannot be a symbolic link: ${rootPath}`);
    }

    // Chromium profile internals may create lock/version symlinks in session storage.
    // Ignore nested symlinks and never follow them.
    return;
  }

  if (stats.isDirectory()) {
    applyMode(rootPath, DIRECTORY_MODE, stats, remediations);

    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    for (const entry of entries) {
      walkSecure(path.join(rootPath, entry.name), remediations, dataDir);
    }

    return;
  }

  if (stats.isFile()) {
    applyMode(rootPath, FILE_MODE, stats, remediations);
  }
}

function enforceSecureRuntimePermissions(dataDir) {
  if (!dataDir || typeof dataDir !== 'string') {
    throw new Error('DATA_DIR must be a non-empty string.');
  }

  fs.mkdirSync(dataDir, { recursive: true, mode: DIRECTORY_MODE });

  const remediations = [];
  walkSecure(dataDir, remediations, dataDir);
  return remediations;
}

module.exports = {
  DIRECTORY_MODE,
  FILE_MODE,
  enforceSecureRuntimePermissions,
  modeToOctal
};
