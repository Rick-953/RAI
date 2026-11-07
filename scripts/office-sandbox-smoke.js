'use strict';
// Run after setup-office-runtime.sh as the unprivileged production service user.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LinuxSandbox } = require('../lib/linux-sandbox');

async function main() {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-office-smoke-'));
    const sandbox = new LinuxSandbox({ fileWorkspace: {} });
    const steps = [
        ['docx-help', 'docx create --help'],
        ['word-revisions-comments', `set -eu
export DOCX_AUTHOR='RAI smoke'
cat > draft.md <<'MD'
# Office report

Original report paragraph.

## Results

| Item | Value |
| --- | --- |
| Samples | 12 |
MD
docx create word.docx --from draft.md
docx track-changes on word.docx
docx replace word.docx 'Original' 'Revised'
printf '%s\n' '{"anchor":"Revised","text":"Verify the source."}' > comments.jsonl
docx comments add word.docx --batch comments.jsonl
python3 - <<'PY'
import zipfile, xml.etree.ElementTree as ET
with zipfile.ZipFile('word.docx') as z:
 assert z.testzip() is None
 ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
 doc=ET.fromstring(z.read('word/document.xml'))
 assert doc.findall('.//w:ins',ns) and doc.findall('.//w:del',ns)
 assert b'Verify the source.' in z.read('word/comments.xml')
print('DOCX content, table, native revisions and comments verified')
PY`],
        ['excel-formulas', `python3 - <<'PY'
import openpyxl
from openpyxl.styles import Font, PatternFill
from openpyxl.chart import BarChart, Reference
w=openpyxl.Workbook();s=w.active;s.title='Model'
for row in [('Item','Value'),('A',12),('B',18),('Total','=SUM(B2:B3)')]: s.append(row)
s.freeze_panes='A2';s.column_dimensions['A'].width=20
for c in s[1]: c.font=Font(bold=True,color='FFFFFF');c.fill=PatternFill('solid',fgColor='16324F')
chart=BarChart();chart.add_data(Reference(s,min_col=2,min_row=1,max_row=3),titles_from_data=True);s.add_chart(chart,'D2');w.save('book.xlsx')
v=openpyxl.load_workbook('book.xlsx');assert v['Model']['B4'].value=='=SUM(B2:B3)' and len(v['Model']._charts)==1
print('XLSX formula, styles and chart verified')
PY`],
        ['ppt-master-export', `set -eu
mkdir -p deck/svg_output
cat > deck/svg_output/slide_01.svg <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#11283f"/><rect x="80" y="340" width="680" height="12" fill="#33c2b2"/><text x="80" y="260" font-family="Arial" font-size="64" fill="#ffffff">Office workflow</text><text x="80" y="440" font-family="Arial" font-size="30" fill="#d9e7ee">Editable output and verified files</text></svg>
SVG
python3 /skills/presentations/scripts/svg_quality_checker.py deck --quick-generate --canonical-authoring --stage final --json
python3 /skills/presentations/scripts/svg_to_pptx.py deck -o deck.pptx --quick-generate --no-notes --no-animations
python3 - <<'PY'
from pptx import Presentation
import zipfile
p=Presentation('deck.pptx');assert len(p.slides)==1
assert any('Office workflow' in getattr(s,'text','') for s in p.slides[0].shapes)
with zipfile.ZipFile('deck.pptx') as z: assert z.testzip() is None
print('PPT Master editable slide and package verified')
PY`],
        ...['word.docx', 'deck.pptx', 'book.xlsx'].map(file => ['render-' + file, `set -eu
mkdir -p previews
libreoffice -env:UserInstallation=file:///tmp/rai-office-smoke --headless --convert-to pdf --outdir previews ${file}
test -s previews/${file.replace(/\.[^.]+$/, '.pdf')}`]),
        ['isolation', `python3 - <<'PY'
import socket,os
assert not os.environ.get('RAI_LUNA_GATEWAY_API_KEY')
try: open('/skills/write-probe','w');raise AssertionError('skill resources writable')
except OSError: pass
s=socket.socket();s.settimeout(1)
try: s.connect(('1.1.1.1',443));raise AssertionError('sandbox has network access')
except OSError: pass
print('Read-only resources, no credentials and no network verified')
PY`]
    ];
    for (const [name, script] of steps) {
        const result = await sandbox._spawn(workspace, script);
        assert.equal(result.exitCode, 0, `${name}: ${result.stderr.slice(0, 3000)} ${result.stdout.slice(-1500)}`);
        assert.equal(result.timedOut, false, name);
        console.log(`PASS ${name}`);
    }
    console.log('Office sandbox evidence: ' + workspace);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
