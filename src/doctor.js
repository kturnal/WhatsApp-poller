require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cron = require('node-cron');
const { loadConfig } = require('./config');
const { DIRECTORY_MODE, FILE_MODE, modeToOctal } = require('./runtime-security');

function printResult(status, message) {
  const prefix = status === 'PASS' ? '[PASS]' : status === 'WARN' ? '[WARN]' : '[FAIL]';
  console.log(`${prefix} ${message}`);
}

function canWriteToDataDir(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });

  const probePath = path.join(
    dataDir,
    `.doctor-write-test-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
  );

  let probeCreated = false;
  let cleanupError = null;

  try {
    fs.writeFileSync(probePath, 'ok', { flag: 'wx' });
    probeCreated = true;
  } catch (error) {
    throw new Error(
      `Failed to create write probe file in DATA_DIR: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    if (probeCreated) {
      try {
        fs.unlinkSync(probePath);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          // If another process removed the probe first, cleanup is effectively complete.
        } else {
          cleanupError = new Error(
            `Failed to remove write probe file in DATA_DIR: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }
  }

  if (cleanupError) {
    throw cleanupError;
  }
}

function checkDataDirPermissions(dataDir) {
  const stats = fs.lstatSync(dataDir);
  if (stats.isSymbolicLink()) {
    throw new Error(`Symbolic links are not allowed inside DATA_DIR: ${dataDir}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`DATA_DIR is not a directory: ${dataDir}`);
  }

  const mode = stats.mode & 0o777;
  if (mode !== DIRECTORY_MODE) {
    printResult(
      'WARN',
      `DATA_DIR permissions are ${modeToOctal(mode)}; recommended ${modeToOctal(DIRECTORY_MODE)}.`
    );
    return;
  }

  printResult('PASS', `DATA_DIR permissions are secure (${modeToOctal(mode)}).`);
}

function checkConfigConsistency(config) {
  if (!cron.validate(config.pollCron)) {
    throw new Error(`Invalid POLL_CRON expression: ${config.pollCron}`);
  }

  if (!config.allowedVoterSet.has(config.ownerJid)) {
    printResult('WARN', 'OWNER_PHONE is not included in ALLOWED_VOTERS.');
  } else {
    printResult('PASS', 'OWNER_PHONE exists in ALLOWED_VOTERS.');
  }

  if (config.allowInsecureChromium) {
    printResult('WARN', 'ALLOW_INSECURE_CHROMIUM=true disables Chromium sandbox protections.');
  } else {
    printResult('PASS', 'Chromium sandbox protections are enabled by default.');
  }
}

function runDoctor() {
  let config;

  try {
    config = loadConfig();
    printResult('PASS', 'Environment variables are valid.');
  } catch (error) {
    printResult('FAIL', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  try {
    checkConfigConsistency(config);
  } catch (error) {
    printResult('FAIL', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }

  try {
    canWriteToDataDir(config.dataDir);
    printResult('PASS', `DATA_DIR is writable (${config.dataDir}).`);
  } catch (error) {
    printResult(
      'FAIL',
      `Cannot write to DATA_DIR (${config.dataDir}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exitCode = 1;
  }

  try {
    checkDataDirPermissions(config.dataDir);
  } catch (error) {
    printResult(
      'WARN',
      `Could not check DATA_DIR permissions (${config.dataDir}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  printResult(
    'PASS',
    `Command guardrails: max ${config.commandRateLimitCount} commands per ${config.commandRateLimitWindowMs}ms, length <= ${config.commandMaxLength}.`
  );

  printResult(
    'PASS',
    `Expected runtime file mode for DB/session files: ${modeToOctal(FILE_MODE)}.`
  );
}

runDoctor();
