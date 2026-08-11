'use strict';

// Browser-facing capability must fail closed unless the production parser is
// explicitly enabled and its OS sandbox is present.
function resolveDocumentSandboxEnabled({ parserEnabled, isProduction, sandboxAvailable } = {}) {
    return Boolean(parserEnabled && isProduction && sandboxAvailable);
}

module.exports = {
    resolveDocumentSandboxEnabled
};
