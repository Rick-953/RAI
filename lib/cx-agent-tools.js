'use strict';

// Contracts implemented by the Windows client in AgentFileTools.cs.
const prop = (type, description) => ({ type, description });
const tool = (name, description, properties, required) => ({ type: 'function', function: {
    name, description, parameters: { type: 'object', additionalProperties: false, properties, required }
} });
const definitions = [
    tool('read_code', 'Read UTF-8 source in the authorized client workspace, with line numbers, revision and next_line. Continue from next_line for more.',
        { path: prop('string', 'Relative file path'), offset: prop('integer', 'First line, default 1'), limit: prop('integer', 'Lines, default 200, up to 1000') }, ['path']),
    tool('edit_code', 'Edit exact source text after read_code. Pass the revision from the read. Ambiguous matches fail unless replace_all is explicit. Preserves line endings and detects concurrent changes.',
        { path: prop('string', 'Relative file path'), revision: prop('string', 'revision from read_code'), old_text: prop('string', 'Exact existing text'),
            new_text: prop('string', 'Replacement text'), replace_all: prop('boolean', 'Replace all occurrences, default false') }, ['path', 'revision', 'old_text', 'new_text']),
    tool('find_files', 'Find source files recursively by glob in the client workspace. Excludes generated and dependency folders. Returns relative paths and truncation status.',
        { pattern: prop('string', 'Glob such as **/*.cs'), limit: prop('integer', 'Results, default 100, up to 200') }, ['pattern']),
    tool('search_code', 'Search UTF-8 source using a regex. Returns matching relative paths and line numbers. Narrow with include for large repositories.',
        { pattern: prop('string', 'Regex'), include: prop('string', 'Optional file glob'), limit: prop('integer', 'Results, default 100, up to 200') }, ['pattern'])
];
const names = definitions.map(value => value.function.name);
const isTool = name => names.includes(name);
const guidance = 'Agent 模式已启用。先读仓库说明和相关代码，用 find_files/search_code 定位、read_code 分页读取，edit_code 携带读取到的 revision 精确修改。保留用户未提交修改；完成后执行相关构建或检查，以实际结果报告。明确的任务持续执行到完成，权限拒绝或需要用户决定时停下。Windows 命令使用 PowerShell 或 cmd.exe，不假设 Bash、/mnt 或 Linux 沙箱存在。技能命令向用户显示可读名称，不展示内部命令名。';

function normalizeArgs(name, args) {
    const definition = definitions.find(value => value.function.name === name)?.function;
    if (!definition || !args || typeof args !== 'object' || Array.isArray(args)) return null;
    const result = {};
    for (const [key, value] of Object.entries(args)) {
        const field = definition.parameters.properties[key];
        if (!field || typeof value !== (field.type === 'integer' ? 'number' : field.type)) return null;
        if (field.type === 'integer' && (!Number.isSafeInteger(value) || value < 1 || value > (key === 'offset' ? 1e7 : name === 'read_code' ? 1000 : 200))) return null;
        if (typeof value === 'string' && value.length > (key === 'old_text' || key === 'new_text' ? 120000 : 2048)) return null;
        result[key] = value;
    }
    if (definition.parameters.required.some(key => result[key] === undefined)) return null;
    if (result.path !== undefined && (!result.path || /^[\\/]|^[A-Za-z]:/.test(result.path) || result.path.split(/[\\/]/).some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]/.test(part)))) return null;
    if (result.pattern !== undefined && !result.pattern.trim()) return null;
    if (name === 'edit_code' && (!result.old_text || !/^[A-Za-z0-9+/]{43}=$/.test(result.revision))) return null;
    return result;
}

module.exports = { definitions, names, isTool, guidance, normalizeArgs };
