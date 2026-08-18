---
name: office
description: Create new Word, Excel, or PowerPoint documents using Python standard-library OOXML templates (zipfile + XML).
---

# Office document creation (docx / xlsx / pptx)

The sandbox has **no internet and no third-party Python packages** — `pip install` always fails. To create a brand-new Office file, build the OOXML package yourself with the Python standard library (`zipfile` + XML strings). Editing an existing Office file is a different task: use `edit_file`, not the templates below. For Excel, never use `update_sheet` or COM on files this skill created — `update_sheet` requires a real workbook on the client side.

## General rules

1. Write your generator script with `sandbox_exec` (python3). Set `output_path` to the single output file (e.g. `report.docx`), or rely on auto-detection when the script creates exactly one supported output file.
2. Escape XML text: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`.
3. Never attempt `pip install`, `apt`, `curl`, or `wget`. The sandbox is offline on purpose; downloading files is done with `fetch_url`, and the fetched file arrives as an attachment `file_id` — never paste a URL into a sandbox script.
4. After generation, sanity-check the package: `python3 -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip() is None, len(z.namelist()))" out.docx` — expect `True N`.

## DOCX — minimal but fully valid template

```python
import zipfile

ESC = lambda s: str(s).replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')

def make_docx(path, title, paragraphs, table=None):
    body = ['<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>%s</w:t></w:r></w:p>' % ESC(title)]
    for para in paragraphs:
        for i, line in enumerate(str(para).split('\n')):
            if i: body.append('<w:p/>')
            body.append('<w:p><w:r><w:t>%s</w:t></w:r></w:p>' % ESC(line))
    if table:
        rows = []
        for row in table:
            cells = ''.join('<w:tc><w:p><w:r><w:t>%s</w:t></w:r></w:p></w:tc>' % ESC(c) for c in row)
            rows.append('<w:tr>%s</w:tr>' % cells)
        body.append('<w:tbl><w:tblPr><w:tblBorders>'
                    '<w:top w:val="single"/><w:left w:val="single"/>'
                    '<w:bottom w:val="single"/><w:right w:val="single"/>'
                    '</w:tblBorders></w:tblPr>%s</w:tbl>' % ''.join(rows))
    document = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
                + ''.join(body) + '</w:body></w:document>')
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            '</Types>')
        z.writestr('_rels/.rels',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            '</Relationships>')
        z.writestr('word/document.xml', document)

make_docx('report.docx', '报告标题', ['第一段', '第二段\n带换行'], [['列A', '列B'], ['1', '2']])
```

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

## PPTX — minimal single slide

```python
import zipfile

ESC = lambda s: str(s).replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')

def make_pptx(path, title, lines):
    body = ''.join('<a:p><a:r><a:t>%s</a:t></a:r></a:p>' % ESC(x) for x in lines)
    slide = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
        '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/>'
        '<p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        '<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>'
        '<a:p><a:r><a:rPr lang="zh-CN" sz="3200" b="1"/><a:t>%s</a:t></a:r></a:p></p:txBody></p:sp>'
        '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        '<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>%s</p:txBody></p:sp>'
        '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
        % (ESC(title), body))
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
            '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
            '</Types>')
        z.writestr('_rels/.rels',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'
            '</Relationships>')
        z.writestr('ppt/presentation.xml',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
            'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
            '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>'
            '<p:sldSz cx="9144000" cy="6858000"/></p:presentation>')
        z.writestr('ppt/_rels/presentation.xml.rels',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>'
            '</Relationships>')
        z.writestr('ppt/slides/slide1.xml', slide)

make_pptx('slides.pptx', '演示标题', ['要点一', '要点二'])
```

## Verify before delivering

After the generator runs, confirm the package integrity with `python3 -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip() is None, len(z.namelist()))" <file>` (expect `True N`) and, when available, `file <file>` (docx → "Microsoft Word 2007+"; xlsx → "Microsoft Excel 2007+"; pptx → "Microsoft PowerPoint 2007+"). Then let the UI deliver the artifact download link and briefly confirm the file is ready.