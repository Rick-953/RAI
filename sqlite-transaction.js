'use strict';

const sqlite3 = require('sqlite3').verbose();
const transactionQueues = new Map();
const SQLITE_BUSY_TIMEOUT_MS = 30000;

function openDatabase(dbPath) {
    return new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(dbPath, (error) => {
            if (error) {
                connection.close(() => reject(error));
                return;
            }
            connection.configure('busyTimeout', SQLITE_BUSY_TIMEOUT_MS);
            resolve(connection);
        });
    });
}

function closeDatabase(connection) {
    return new Promise((resolve, reject) => {
        connection.close((error) => error ? reject(error) : resolve());
    });
}

function createSqliteClient(connection) {
    return {
        get(sql, params = []) {
            return new Promise((resolve, reject) => {
                connection.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
            });
        },
        all(sql, params = []) {
            return new Promise((resolve, reject) => {
                connection.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || []));
            });
        },
        run(sql, params = []) {
            return new Promise((resolve, reject) => {
                connection.run(sql, params, function onRun(error) {
                    if (error) reject(error);
                    else resolve({ changes: this.changes, lastID: this.lastID });
                });
            });
        },
        exec(sql) {
            return new Promise((resolve, reject) => {
                connection.exec(sql, (error) => error ? reject(error) : resolve());
            });
        }
    };
}

async function executeImmediateTransaction(dbPath, callback) {
    const connection = await openDatabase(dbPath);
    const tx = createSqliteClient(connection);
    let began = false;
    try {
        await tx.exec(`
            PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
            PRAGMA foreign_keys = ON;
            PRAGMA synchronous = NORMAL;
        `);
        await tx.exec('BEGIN IMMEDIATE TRANSACTION');
        began = true;
        const result = await callback(tx);
        await tx.exec('COMMIT');
        began = false;
        return result;
    } catch (error) {
        if (began) {
            await tx.exec('ROLLBACK').catch(() => null);
        }
        throw error;
    } finally {
        await closeDatabase(connection).catch(() => null);
    }
}

function withImmediateTransaction(dbPath, callback) {
    const queueKey = String(dbPath || '');
    const previous = transactionQueues.get(queueKey) || Promise.resolve();
    const current = previous
        .catch(() => undefined)
        .then(() => executeImmediateTransaction(dbPath, callback));
    const queueTail = current.then(() => undefined, () => undefined);
    transactionQueues.set(queueKey, queueTail);
    queueTail.finally(() => {
        if (transactionQueues.get(queueKey) === queueTail) {
            transactionQueues.delete(queueKey);
        }
    });
    return current;
}

module.exports = {
    createSqliteClient,
    withImmediateTransaction
};
