'use strict';

const fs = require('fs');

const [metadataPath, outputPath] = process.argv.slice(2);
if (!metadataPath || !outputPath) throw new Error('usage: local-agent-sbom <cargo-metadata.json> <output.json>');
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
const components = (metadata.packages || []).map((pkg) => {
    const component = {
        type: 'library',
        'bom-ref': `pkg:cargo/${encodeURIComponent(pkg.name)}@${encodeURIComponent(pkg.version)}`,
        name: pkg.name,
        version: pkg.version,
        purl: `pkg:cargo/${encodeURIComponent(pkg.name)}@${encodeURIComponent(pkg.version)}`
    };
    if (pkg.license) component.licenses = [{ expression: pkg.license }];
    if (pkg.source) component.externalReferences = [{ type: 'distribution', url: pkg.source }];
    return component;
});
const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${cryptoRandomUuid()}`,
    version: 1,
    metadata: {
        timestamp: new Date().toISOString(),
        component: components.find((item) => item.name === 'rai-agent') || { type: 'application', name: 'rai-agent' }
    },
    components
};
fs.writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`, { flag: 'wx' });

function cryptoRandomUuid() {
    return require('crypto').randomUUID();
}
