---
name: spreadsheets
description: Excel XLSX and CSV creation, formulas and validation.
---

# Excel XLSX and CSV creation, formulas and validation.

Use only supplied tools. Native CX RAI local mode: use create_artifact/edit_file; xlsx: tab-separated cells; ### sheet-name starts a sheet; = starts formulas. update_sheet handles existing workbooks; never repeat its work using COM. No Python, COM or template file assumptions.

Server sandbox mode: offline Python standard library only; use sandbox_exec and the following format-specific template. Preserve original files when editing.

## General rules

1. Write your generator script with `sandbox_exec` (python3). Set `output_path` to the single output file (e.g. `report.docx`), or rely on auto-detection when the script creates exactly one supported output file.
2. Escape XML text: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`.
3. Never attempt `pip install`, `apt`, `curl`, or `wget`. The sandbox is offline on purpose; downloading files is done with `fetch_url`, and the fetched file arrives as an attachment `file_id` — never paste a URL into a sandbox script.
4. After generation, sanity-check the package: `python3 -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip() is None, len(z.namelist()))" out.docx` — expect `True N`.

## XLSX — single sheet with inline strings (no sharedStrings needed)

```python
import zipfile

ESC = lambda s: str(s).replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')

def build_sheet_xml(rows):
    out = []
    for r, row in enumerate(rows, start=1):
        cells = []
        for c, val in enumerate(row, start=1):
            ref = '%s%d' % (chr(64 + c), r)   # A1, B1, ... (single-letter cols work to column Z)
            cells.append('<c r="%s" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>' % (ref, ESC(val)))
        out.append('<row r="%d">%s</row>' % (r, ''.join(cells)))
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<sheetData>%s</sheetData></worksheet>' % ''.join(out))

def make_xlsx(path, sheet_name, rows):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '</Types>')
        z.writestr('_rels/.rels',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>')
        z.writestr('xl/workbook.xml',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="%s" sheetId="1" r:id="rId1"/></sheets></workbook>'
            % ESC(sheet_name)[:31])
        z.writestr('xl/_rels/workbook.xml.rels',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            '</Relationships>')
        z.writestr('xl/worksheets/sheet1.xml', build_sheet_xml(rows))

make_xlsx('table.xlsx', 'Sheet1', [['名称', '数量'], ['苹果', 3], ['香蕉', 5]])
```

## Verify before delivering

After the generator runs, confirm the package integrity with `python3 -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip() is None, len(z.namelist()))" <file>` (expect `True N`) and, when available, `file <file>` (docx → "Microsoft Word 2007+"; xlsx → "Microsoft Excel 2007+"; pptx → "Microsoft PowerPoint 2007+"). Then let the UI deliver the artifact download link and briefly confirm the file is ready.