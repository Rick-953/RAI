#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { createSoftwareClientAuth } = require('../lib/software-client-auth');

function usage() {
    return [
        'Usage:',
        '  node scripts/software-client-key-cli.js create --name <name> --platform <platform> [--package-name <id>] [--raw | --output <path>] [--db <path>]',
        '  node scripts/software-client-key-cli.js list [--db <path>]',
        '  node scripts/software-client-key-cli.js revoke <keyId> [--db <path>]'
    ].join('\n');
}

function parseArgs(argv) {
    const options = { raw: false, db: path.join(__dirname, '..', 'ai_data.db') };
    const positional = [];
    let command = '';
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (!command && !arg.startsWith('-')) {
            command = arg;
            continue;
        }
        if (arg === '--raw') {
            options.raw = true;
            continue;
        }
        if (['--db', '--name', '--platform', '--package-name', '--key-id', '--output'].includes(arg)) {
            const value = argv[index + 1];
            if (!value || value.startsWith('--')) throw new Error(`missing_value:${arg}`);
            options[arg.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
            index += 1;
            continue;
        }
        if (arg.startsWith('-')) throw new Error(`unknown_option:${arg}`);
        positional.push(arg);
    }
    return { command, options, positional };
}

function openDatabase(dbPath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(path.resolve(dbPath), (error) => {
            if (error) reject(error);
            else resolve(db);
        });
    });
}

function runAsync(db, sql) {
    return new Promise((resolve, reject) => db.run(sql, (error) => (error ? reject(error) : resolve())));
}

function closeDatabase(db) {
    return new Promise((resolve, reject) => db.close((error) => (error ? reject(error) : resolve())));
}

function openSecretOutput(outputPath) {
    const resolvedPath = path.resolve(outputPath);
    const fileDescriptor = fs.openSync(resolvedPath, 'wx', 0o600);
    fs.fchmodSync(fileDescriptor, 0o600);
    return { fileDescriptor, resolvedPath };
}

function closeFile(fileDescriptor) {
    if (fileDescriptor === null) return;
    fs.closeSync(fileDescriptor);
}

async function main(argv = process.argv.slice(2)) {
    const { command, options, positional } = parseArgs(argv);
    if (!['create', 'list', 'revoke'].includes(command)) throw new Error('unknown_command');
    if (options.output && command !== 'create') throw new Error('output_is_create_only');
    if (options.output && options.raw) throw new Error('raw_and_output_are_mutually_exclusive');
    const db = await openDatabase(options.db);
    try {
        await runAsync(db, 'PRAGMA busy_timeout=5000');
        const store = createSoftwareClientAuth({ db });
        await store.migrate();

        if (command === 'create') {
            let output = null;
            let created = null;
            try {
                if (options.output) output = openSecretOutput(options.output);
                created = await store.create({
                    name: options.name,
                    platform: options.platform,
                    packageName: options.packageName || ''
                });
                if (output) {
                    fs.writeFileSync(output.fileDescriptor, `${created.rawKey}\n`, { encoding: 'utf8' });
                    fs.fsyncSync(output.fileDescriptor);
                    closeFile(output.fileDescriptor);
                    output.fileDescriptor = null;
                }
            } catch (error) {
                let revokeError = null;
                if (created?.client?.keyId) {
                    try {
                        await store.revoke(created.client.keyId);
                    } catch (failure) {
                        revokeError = failure;
                    }
                }
                if (output) {
                    try {
                        closeFile(output.fileDescriptor);
                    } catch (_closeError) {
                        // Continue cleanup without hiding the original failure.
                    }
                    try {
                        fs.unlinkSync(output.resolvedPath);
                    } catch (_unlinkError) {
                        // The file may not exist if exclusive creation itself failed.
                    }
                }
                if (revokeError) {
                    throw new AggregateError(
                        [error, revokeError],
                        'secret_output_failed_and_credential_revocation_failed'
                    );
                }
                throw error;
            }
            process.stderr.write(
                output
                    ? `Created software client ${created.client.keyId}. The one-time key was saved to the requested file.\n`
                    : `Created software client ${created.client.keyId}. The key is shown once and cannot be recovered.\n`
            );
            if (output) {
                process.stdout.write(`${JSON.stringify({ client: created.client, keyFile: output.resolvedPath }, null, 2)}\n`);
            } else if (options.raw) {
                process.stdout.write(`${created.rawKey}\n`);
            } else {
                process.stdout.write(`${JSON.stringify({ key: created.rawKey, client: created.client }, null, 2)}\n`);
            }
            return;
        }

        if (command === 'list') {
            process.stdout.write(`${JSON.stringify(await store.list(), null, 2)}\n`);
            return;
        }

        const keyId = options.keyId || positional[0];
        if (!keyId) throw new Error('revoke_requires_key_id');
        const revoked = await store.revoke(keyId);
        if (!revoked) throw new Error('software_client_not_found');
        process.stderr.write(`Revoked software client ${revoked.keyId}.\n`);
        process.stdout.write(`${JSON.stringify(revoked, null, 2)}\n`);
    } finally {
        await closeDatabase(db);
    }
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error?.message || 'software_client_cli_failed'}\n${usage()}\n`);
        process.exitCode = 1;
    });
}

module.exports = { main, parseArgs };
