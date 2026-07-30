'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function createRuntimeReportWriter(reportPath, options = {}) {
  const resolvedPath = path.resolve(String(reportPath || ''));
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes >= 1024
    ? options.maxBytes
    : DEFAULT_MAX_BYTES;
  assert.ok(path.basename(resolvedPath), 'runtime report path is required');
  let writeQueue = Promise.resolve();

  async function validateExistingPath() {
    try {
      const stat = await fs.promises.lstat(resolvedPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error('runtime_report_target_not_single_regular_file');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  async function appendBlock(block) {
    const data = Buffer.from(String(block || ''), 'utf8');
    if (data.length > maxBytes) throw new Error('runtime_report_entry_too_large');
    await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
    await validateExistingPath();

    const flags = fs.constants.O_APPEND
      | fs.constants.O_CREAT
      | fs.constants.O_WRONLY
      | (fs.constants.O_NOFOLLOW || 0);
    const handle = await fs.promises.open(resolvedPath, flags, 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('runtime_report_target_not_single_regular_file');
      await handle.chmod(0o600);
      if (stat.size + data.length > maxBytes) await handle.truncate(0);
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
  }

  return function queueRuntimeReportBlock(block) {
    const operation = writeQueue.then(() => appendBlock(block));
    writeQueue = operation.catch(() => undefined);
    return operation;
  };
}

module.exports = {
  createRuntimeReportWriter,
  DEFAULT_MAX_BYTES
};
