---
name: documents
description: Word DOCX creation and editing.
---

# Word DOCX creation and editing.

Use only supplied tools. Native CX RAI local mode: use create_artifact/edit_file; docx: headings #..#####, lists -/*, **bold**, *italic*, pipe tables, !img:relative-file. No Python, COM or template file assumptions.

Server sandbox mode: offline Python standard library only; use sandbox_exec and the following format-specific template. Preserve original files when editing.

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

## Verify before delivering

After the generator runs, confirm the package integrity with `python3 -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip() is None, len(z.namelist()))" <file>` (expect `True N`) and, when available, `file <file>` (docx → "Microsoft Word 2007+"; xlsx → "Microsoft Excel 2007+"; pptx → "Microsoft PowerPoint 2007+"). Then let the UI deliver the artifact download link and briefly confirm the file is ready.