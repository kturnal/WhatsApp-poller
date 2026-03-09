const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DIRECTORY_MODE,
  FILE_MODE,
  enforceSecureRuntimePermissions
} = require('../../src/runtime-security');

function modeOf(targetPath) {
  return fs.statSync(targetPath).mode & 0o777;
}

test('enforceSecureRuntimePermissions hardens directory and file modes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-poller-runtime-security-'));
  const dataDir = path.join(tempDir, 'data');
  const nestedDir = path.join(dataDir, 'nested');
  const nestedFile = path.join(nestedDir, 'payload.txt');

  fs.mkdirSync(nestedDir, { recursive: true, mode: 0o755 });
  fs.writeFileSync(nestedFile, 'ok', 'utf8');
  fs.chmodSync(dataDir, 0o755);
  fs.chmodSync(nestedDir, 0o755);
  fs.chmodSync(nestedFile, 0o644);

  try {
    const remediations = enforceSecureRuntimePermissions(dataDir);

    assert.ok(remediations.length >= 3);
    assert.equal(modeOf(dataDir), DIRECTORY_MODE);
    assert.equal(modeOf(nestedDir), DIRECTORY_MODE);
    assert.equal(modeOf(nestedFile), FILE_MODE);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('enforceSecureRuntimePermissions ignores nested symlinks without following them', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-poller-runtime-security-'));
  const dataDir = path.join(tempDir, 'data');
  const sessionDir = path.join(dataDir, 'session');
  const externalDir = path.join(tempDir, 'external');
  const externalFile = path.join(externalDir, 'outside.txt');
  const symlinkPath = path.join(sessionDir, 'RunningChromeVersion');

  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(externalDir, { recursive: true });
  fs.writeFileSync(externalFile, 'outside', 'utf8');
  fs.chmodSync(externalFile, 0o644);
  fs.symlinkSync(externalFile, symlinkPath);

  try {
    assert.doesNotThrow(() => enforceSecureRuntimePermissions(dataDir));
    assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true);
    assert.equal(modeOf(externalFile), 0o644);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('enforceSecureRuntimePermissions rejects DATA_DIR when root path is a symlink', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-poller-runtime-security-'));
  const realDir = path.join(tempDir, 'real-data');
  const symlinkDir = path.join(tempDir, 'data');

  fs.mkdirSync(realDir, { recursive: true });
  fs.symlinkSync(realDir, symlinkDir, 'dir');

  try {
    assert.throws(
      () => enforceSecureRuntimePermissions(symlinkDir),
      /DATA_DIR cannot be a symbolic link/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('enforceSecureRuntimePermissions ignores files that disappear before lstat', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-poller-runtime-security-'));
  const dataDir = path.join(tempDir, 'data');
  const volatileDir = path.join(dataDir, 'session');
  const volatileFile = path.join(volatileDir, '000948.log');
  const originalLstatSync = fs.lstatSync;

  fs.mkdirSync(volatileDir, { recursive: true });
  fs.writeFileSync(volatileFile, 'volatile', 'utf8');

  fs.lstatSync = (targetPath, ...args) => {
    if (targetPath === volatileFile) {
      const error = new Error(`ENOENT: no such file or directory, lstat '${targetPath}'`);
      error.code = 'ENOENT';
      throw error;
    }

    return originalLstatSync.call(fs, targetPath, ...args);
  };

  try {
    assert.doesNotThrow(() => enforceSecureRuntimePermissions(dataDir));
  } finally {
    fs.lstatSync = originalLstatSync;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('enforceSecureRuntimePermissions ignores files that disappear before chmod', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-poller-runtime-security-'));
  const dataDir = path.join(tempDir, 'data');
  const volatileDir = path.join(dataDir, 'session');
  const volatileFile = path.join(volatileDir, '000949.log');
  const originalChmodSync = fs.chmodSync;

  fs.mkdirSync(volatileDir, { recursive: true });
  fs.writeFileSync(volatileFile, 'volatile', 'utf8');
  fs.chmodSync(volatileFile, 0o644);

  fs.chmodSync = (targetPath, mode, ...args) => {
    if (targetPath === volatileFile) {
      fs.rmSync(volatileFile, { force: true });
      const error = new Error(`ENOENT: no such file or directory, chmod '${targetPath}'`);
      error.code = 'ENOENT';
      throw error;
    }

    return originalChmodSync.call(fs, targetPath, mode, ...args);
  };

  try {
    assert.doesNotThrow(() => enforceSecureRuntimePermissions(dataDir));
  } finally {
    fs.chmodSync = originalChmodSync;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
