'use strict';

const fs = require('fs');

const ENV_PATH = '/rick/apps/rai-beta/.env';
const raw = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
const env = {};

for (const line of raw.split(/\r?\n/)) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) continue;
  let value = match[2];
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  env[match[1]] = value;
}

module.exports = {
  apps: [{
    name: 'rai-beta',
    script: '/rick/apps/rai-beta/server.js',
    cwd: '/rick/apps/rai-beta',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    max_memory_restart: '1500M',
    env
  }]
};
