const { DateTime } = require('luxon');

const defaultLogOptions = {
  redactSensitive: true,
  includeStack: false
};

let runtimeLogOptions = { ...defaultLogOptions };

function formatMode(mode) {
  return mode.toString(8).padStart(4, '0');
}

function maskIdentifier(input) {
  if (typeof input !== 'string') {
    return input;
  }

  if (input.length <= 4) {
    return '***';
  }

  return `${input.slice(0, 2)}***${input.slice(-2)}`;
}

function maskPhoneLike(input) {
  const characters = input.split('');
  const digitIndices = [];

  characters.forEach((character, index) => {
    if (/\d/.test(character)) {
      digitIndices.push(index);
    }
  });

  if (digitIndices.length <= 4) {
    return '***';
  }

  for (let i = 2; i < digitIndices.length - 2; i += 1) {
    characters[digitIndices[i]] = '*';
  }

  return characters.join('');
}

function redactSensitiveText(text) {
  if (typeof text !== 'string') {
    return text;
  }

  let result = text;

  result = result.replace(
    /\b([0-9]{4,})(@(c|g)\.us)\b/gi,
    (_, local, suffix) => `${maskIdentifier(local)}${suffix}`
  );

  result = result.replace(
    /(^|[^\d])(\+?[0-9][0-9().\-\s]{6,}[0-9])(?=$|[^\d])/g,
    (_, prefix, body) => {
      const digits = body.replace(/[^\d]/g, '');
      if (digits.length < 7) {
        return `${prefix}${body}`;
      }

      const masked = maskPhoneLike(body);
      return `${prefix}${masked}`;
    }
  );

  return result;
}

function redactValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);
    const output = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      if (key === 'stack' && !runtimeLogOptions.includeStack) {
        continue;
      }
      output[key] = redactValue(nestedValue, seen);
    }
    seen.delete(value);
    return output;
  }

  return value;
}

function setLogOptions(options = {}) {
  runtimeLogOptions = {
    ...defaultLogOptions,
    ...runtimeLogOptions,
    ...options
  };
}

function errorMetadata(error, extra = null) {
  const metadata = {
    error: error instanceof Error ? error.message : String(error)
  };

  if (runtimeLogOptions.includeStack && error instanceof Error && error.stack) {
    metadata.stack = error.stack;
  }

  if (extra && typeof extra === 'object') {
    Object.assign(metadata, extra);
  }

  return metadata;
}

function log(level, message, metadata = null) {
  const timestamp = DateTime.now().toISO();
  const prefix = `[${timestamp}] [${level}] ${message}`;

  if (metadata === null || metadata === undefined) {
    console.log(prefix);
    return;
  }

  const normalizedMetadata = runtimeLogOptions.redactSensitive ? redactValue(metadata) : metadata;

  console.log(`${prefix} ${JSON.stringify(normalizedMetadata)}`);
}

module.exports = {
  errorMetadata,
  formatMode,
  log,
  redactSensitiveText,
  setLogOptions
};
