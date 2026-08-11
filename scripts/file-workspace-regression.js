'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    FileWorkspace,
    FileWorkspaceError,
    ARTIFACT_FORMATS,
    MAX_ACTIVE_TASKS,
    MAX_OWNER_ACTIVE_TASKS,
    MAX_WORKSPACE_BYTES,
    READ_MODES,
    TRANSFORM_OPERATIONS
} = require('../lib/file-workspace');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-file-workspace-regression-'));
const uploadsRoot = path.join(root, 'uploads');
fs.mkdirSync(uploadsRoot, { mode: 0o700 });
let clock = Date.now();
let parserCallCount = 0;

function expectCode(promise, code) {
    return promise.then(
        () => assert.fail(`expected ${code}`),
        (error) => assert.equal(error.code, code)
    );
}

async function writeUpload(name, content) {
    const fileName = `${String(Date.now()).slice(0, 13)}-${'a'.repeat(12)}.${name.split('.').pop()}`;
    await fs.promises.writeFile(path.join(uploadsRoot, fileName), content, { mode: 0o600 });
    return {
        rootDir: uploadsRoot,
        storageName: fileName,
        fileId: fileName,
        fileName: name,
        mimeType: 'text/plain',
        ownerUserId: 7
    };
}

async function main() {
    const workspace = new FileWorkspace({
        rootDir: path.join(root, 'jobs'),
        ttlMs: 900000,
        cleanupIntervalMs: 10000,
        now: () => clock,
        parseDocumentFile: async (sourcePath, kind) => {
            parserCallCount += 1;
            if (kind === 'csv') {
                assert.equal(await fs.promises.readFile(sourcePath, 'utf8'), 'Name,Status\nRAI,ready\n');
                return { text: '| Name | Status |\n| --- | --- |\n| RAI | ready |' };
            }
            return { text: '# parsed office' };
        }
    });
    await workspace.init();

    assert.equal(ARTIFACT_FORMATS.has('json'), true);
    assert.equal(MAX_ACTIVE_TASKS, 64);
    assert.equal(MAX_OWNER_ACTIVE_TASKS, 8);
    assert.equal(MAX_WORKSPACE_BYTES, 40 * 1024 * 1024);
    assert.equal(READ_MODES.has('metadata'), true);
    assert.equal(TRANSFORM_OPERATIONS.has('json_pretty'), true);

    const textSource = await writeUpload('notes.txt', 'hello workspace');
    const metadata = await workspace.readFile({ userId: 7, sessionId: 'session_alpha', source: textSource, mode: 'metadata' });
    assert.equal(metadata.metadata.size, 15);
    const read = await workspace.readFile({ userId: 7, sessionId: 'session_alpha', source: textSource, mode: 'text' });
    assert.equal(read.text, 'hello workspace');

    await expectCode(
        workspace.readFile({ userId: 8, sessionId: 'session_alpha', source: textSource, mode: 'text' }),
        'workspace_source_forbidden'
    );

    const jsonSource = await writeUpload('data.json', '{"b":2,"a":[1]}');
    const transformed = await workspace.transformFile({
        userId: 7,
        sessionId: 'session_alpha',
        source: jsonSource,
        operation: 'json_pretty',
        fileName: 'pretty.json'
    });
    assert.match(transformed.downloadPath, /^\/api\/file-jobs\/[a-f0-9]{48}\/artifacts\/[a-f0-9]{32}\?sessionId=session_alpha$/);
    const firstDownload = await workspace.prepareDownload({
        userId: 7,
        sessionId: 'session_alpha',
        taskId: transformed.taskId,
        artifactId: transformed.artifactId
    });
    assert.equal(firstDownload.fileName, 'pretty.json');
    assert.equal((await fs.promises.readFile(firstDownload.filePath, 'utf8')).includes('"a"'), true);
    await firstDownload.finalize();

    const csvSource = await writeUpload('report.csv', 'Name,Status\nRAI,ready\n');
    const csvArtifact = await workspace.transformFile({
        userId: 7,
        sessionId: 'session_alpha',
        source: csvSource,
        operation: 'csv_to_markdown'
    });
    const csvDownload = await workspace.prepareDownload({
        userId: 7,
        sessionId: 'session_alpha',
        taskId: csvArtifact.taskId,
        artifactId: csvArtifact.artifactId
    });
    assert.equal(
        await fs.promises.readFile(csvDownload.filePath, 'utf8'),
        '| Name | Status |\n| --- | --- |\n| RAI | ready |'
    );
    assert.equal(parserCallCount, 1);
    await csvDownload.finalize();
    await expectCode(
        workspace.prepareDownload({ userId: 7, sessionId: 'session_alpha', taskId: transformed.taskId, artifactId: transformed.artifactId }),
        'workspace_task_missing'
    );

    const artifact = await workspace.createArtifact({
        userId: 7,
        sessionId: 'session_alpha',
        format: 'markdown',
        content: '# generated\n\nfixed operation',
        fileName: '../../should-not-be-a-path.md'
    });
    assert.equal(artifact.fileName, '.._.._should-not-be-a-path.md');
    await expectCode(
        workspace.prepareDownload({ userId: 8, sessionId: 'session_alpha', taskId: artifact.taskId, artifactId: artifact.artifactId }),
        'workspace_artifact_forbidden'
    );
    await expectCode(
        workspace.prepareDownload({ userId: 7, sessionId: 'session_other', taskId: artifact.taskId, artifactId: artifact.artifactId }),
        'workspace_artifact_forbidden'
    );
    const ownedDownload = await workspace.prepareDownload({
        userId: 7,
        sessionId: 'session_alpha',
        taskId: artifact.taskId,
        artifactId: artifact.artifactId
    });
    await expectCode(
        workspace.prepareDownload({ userId: 7, sessionId: 'session_alpha', taskId: artifact.taskId, artifactId: artifact.artifactId }),
        'workspace_artifact_consumed'
    );
    await ownedDownload.finalize();
    const commandLikeName = await workspace.createArtifact({
        userId: 7,
        sessionId: 'session_alpha',
        format: 'text',
        content: 'literal data',
        fileName: '$(id).txt'
    });
    assert.equal(commandLikeName.fileName, '$(id).txt');
    assert.match(commandLikeName.downloadPath, /^\/api\/file-jobs\/[a-f0-9]{48}\/artifacts\/[a-f0-9]{32}\?sessionId=session_alpha$/);
    const literalDownload = await workspace.prepareDownload({
        userId: 7,
        sessionId: 'session_alpha',
        taskId: commandLikeName.taskId,
        artifactId: commandLikeName.artifactId
    });
    assert.equal(await fs.promises.readFile(literalDownload.filePath, 'utf8'), 'literal data');
    await literalDownload.finalize();
    await expectCode(
        workspace.createArtifact({ userId: 7, sessionId: 'session_alpha', format: 'shell', content: 'id' }),
        'workspace_format_blocked'
    );
    await expectCode(
        workspace.transformFile({ userId: 7, sessionId: 'session_alpha', source: textSource, operation: 'shell' }),
        'workspace_operation_blocked'
    );
    await expectCode(
        workspace.readFile({
            userId: 7,
            sessionId: 'session_alpha',
            source: { ...textSource, storageName: '../notes.txt' },
            mode: 'text'
        }),
        'workspace_source_invalid'
    );

    const expiring = await workspace.createArtifact({ userId: 7, sessionId: 'session_alpha', format: 'text', content: 'expires' });
    clock += 900001;
    await expectCode(
        workspace.prepareDownload({ userId: 7, sessionId: 'session_alpha', taskId: expiring.taskId, artifactId: expiring.artifactId }),
        'workspace_artifact_expired'
    );
    assert.equal(fs.existsSync(path.join(workspace.rootDir, expiring.taskId)), false);

    const cleanupArtifact = await workspace.createArtifact({ userId: 7, sessionId: 'session_alpha', format: 'text', content: 'cleanup' });
    clock += 900001;
    assert.ok((await workspace.cleanupExpired()) >= 1);
    assert.equal(fs.existsSync(path.join(workspace.rootDir, cleanupArtifact.taskId)), false);

    const outside = path.join(root, 'outside-keep');
    await fs.promises.mkdir(outside);
    const symlinkName = 'b'.repeat(48);
    await fs.promises.symlink(outside, path.join(workspace.rootDir, symlinkName));
    await workspace.cleanupExpired();
    assert.equal(fs.existsSync(outside), true);

    await expectCode(
        workspace.prepareDownload({ userId: 7, sessionId: 'session_alpha', taskId: '../etc', artifactId: 'a'.repeat(32) }),
        'workspace_task_invalid'
    );

    const limitedWorkspace = new FileWorkspace({
        rootDir: path.join(root, 'limited-jobs'),
        maxActiveTasks: 3,
        maxOwnerActiveTasks: 2,
        maxWorkspaceBytes: 2 * 1024 * 1024,
        now: () => clock
    });
    await limitedWorkspace.init();
    const limitedOne = await limitedWorkspace.createArtifact({ userId: 21, sessionId: 'limited', format: 'text', content: 'one' });
    await limitedWorkspace.createArtifact({ userId: 21, sessionId: 'limited', format: 'text', content: 'two' });
    await expectCode(
        limitedWorkspace.createArtifact({ userId: 21, sessionId: 'limited', format: 'text', content: 'owner-limit' }),
        'workspace_owner_task_limit'
    );
    await limitedWorkspace.createArtifact({ userId: 22, sessionId: 'limited', format: 'text', content: 'three' });
    await expectCode(
        limitedWorkspace.createArtifact({ userId: 23, sessionId: 'limited', format: 'text', content: 'global-limit' }),
        'workspace_task_capacity_exceeded'
    );
    const limitedDownload = await limitedWorkspace.prepareDownload({
        userId: 21,
        sessionId: 'limited',
        taskId: limitedOne.taskId,
        artifactId: limitedOne.artifactId
    });
    await limitedDownload.finalize();
    await limitedWorkspace.createArtifact({ userId: 23, sessionId: 'limited', format: 'text', content: 'capacity-recovered' });

    const serverSource = await fs.promises.readFile(path.join(__dirname, '..', 'server.js'), 'utf8');
    const appSource = await fs.promises.readFile(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const workspaceSource = await fs.promises.readFile(path.join(__dirname, '..', 'lib', 'file-workspace.js'), 'utf8');
    assert.doesNotMatch(workspaceSource, /require\(['"]child_process['"]\)|\bexec(?:File|Sync)?\s*\(|\bspawn\s*\(/);
    for (const toolName of ['read_file', 'transform_file', 'edit_file', 'create_artifact', 'sandbox_exec']) {
        assert.match(serverSource, new RegExp(`name: ['"]${toolName}['"]`));
    }
    assert.match(serverSource, /WHERE id = \? AND user_id = \?/);
    assert.match(serverSource, /WHERE filename = \? AND user_id = \? AND upload_kind = 'attachment'/);
    assert.match(serverSource, /app\.get\('\/api\/file-jobs\/:taskId\/artifacts\/:artifactId', authenticateToken/);
    assert.match(serverSource, /read_file\|transform_file\|edit_file\|create_artifact\|sandbox_exec/);
    assert.match(serverSource, /functionDeclarations: runtimeToolDefinitions\.map/);
    assert.match(serverSource, /normalizeWorkspaceToolArgs/);
    assert.match(serverSource, /download_available: true/);
    assert.doesNotMatch(serverSource, /download_url:\s*result\?\.downloadPath/);
    assert.match(appSource, /downloadFileJobArtifact/);
    assert.match(appSource, /'Authorization': `Bearer \$\{appState\.token\}`/);

    workspace.stopCleanup();
    await fs.promises.rm(root, { recursive: true, force: true });
    console.log('file workspace regression passed (ownership, expiry, resource caps)');
}

main().catch(async (error) => {
    await fs.promises.rm(root, { recursive: true, force: true }).catch(() => null);
    console.error(error.stack || error);
    process.exitCode = 1;
});
