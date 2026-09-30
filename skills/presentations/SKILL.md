---
name: presentations
description: PowerPoint PPTX creation and editing.
---

# PowerPoint PPTX creation and editing.

Use only supplied tools. Native CX RAI local mode: use create_artifact/edit_file; pptx: --- separates slides; first line is title; #theme: blue/green/purple/dark selects a color, not a template path; !img:relative-file embeds an existing image. No Python, COM or template file assumptions.

Server sandbox mode: offline Python standard library only; use sandbox_exec and the following format-specific template. Preserve original files when editing.

## General rules

1. Write your generator script with `sandbox_exec` (python3). Set `output_path` to the single output file (e.g. `report.docx`), or rely on auto-detection when the script creates exactly one supported output file.
2. Escape XML text: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`.
3. Never attempt `pip install`, `apt`, `curl`, or `wget`. The sandbox is offline on purpose; downloading files is done with `fetch_url`, and the fetched file arrives as an attachment `file_id` — never paste a URL into a sandbox script.
4. After generation, sanity-check the package: `python3 -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip() is None, len(z.namelist()))" out.docx` — expect `True N`.

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