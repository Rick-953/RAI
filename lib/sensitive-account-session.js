'use strict';

class SensitiveAccountMutationError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'SensitiveAccountMutationError';
        this.code = code;
    }
}

function normalizeUserId(value) {
    const userId = Number(value);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        throw new TypeError('userId must be a positive integer');
    }
    return userId;
}

function normalizeSessionVersion(value) {
    const version = Number(value);
    if (!Number.isSafeInteger(version) || version <= 0) {
        throw new SensitiveAccountMutationError(
            'invalid_session_version',
            'users.session_version must be a positive integer'
        );
    }
    return version;
}

/*
 * Security invariant for credential and account-identity changes:
 *
 *   business mutation + users.session_version increment = one SQLite commit.
 *
 * A trigger, constraint, I/O error, or process failure during either half must
 * roll back both halves.  Auth-session rows are only a cleanup concern after
 * this commits: access and refresh verification always compares against the
 * current users.session_version.
 */
async function runSensitiveAccountMutation({ withTransaction, userId, mutate }) {
    if (typeof withTransaction !== 'function') {
        throw new TypeError('withTransaction must be a function');
    }
    if (typeof mutate !== 'function') {
        throw new TypeError('mutate must be a function');
    }
    const numericUserId = normalizeUserId(userId);

    return withTransaction(async (tx) => {
        if (!tx || typeof tx.get !== 'function' || typeof tx.run !== 'function') {
            throw new TypeError('transaction must expose get() and run()');
        }
        const before = await tx.get(
            'SELECT COALESCE(session_version, 1) AS session_version FROM users WHERE id = ?',
            [numericUserId]
        );
        if (!before) {
            throw new SensitiveAccountMutationError('user_not_found', 'User does not exist');
        }
        const previousSessionVersion = normalizeSessionVersion(before.session_version);
        const value = await mutate(tx, {
            userId: numericUserId,
            previousSessionVersion
        });

        const bumped = await tx.run(
            `UPDATE users
             SET session_version = ?
             WHERE id = ? AND COALESCE(session_version, 1) = ?`,
            [previousSessionVersion + 1, numericUserId, previousSessionVersion]
        );
        if (Number(bumped?.changes || 0) !== 1) {
            throw new SensitiveAccountMutationError(
                'session_version_state_changed',
                'User session version changed during a sensitive account mutation'
            );
        }

        const after = await tx.get(
            'SELECT session_version FROM users WHERE id = ?',
            [numericUserId]
        );
        const sessionVersion = normalizeSessionVersion(after?.session_version);
        if (sessionVersion !== previousSessionVersion + 1) {
            throw new SensitiveAccountMutationError(
                'session_version_postcondition_failed',
                'Sensitive account mutation did not increment the session version exactly once'
            );
        }

        return { value, previousSessionVersion, sessionVersion };
    });
}

module.exports = {
    SensitiveAccountMutationError,
    runSensitiveAccountMutation
};
