---
name: documents
description: Word DOCX creation and editing.
---

# Word — docx-cli

Prefer pinned kklimuk/docx-cli 0.28.0 for creating, editing, redlining and commenting on DOCX. Its guides and references are read-only at `/skills/documents` (SKILL_DIR); `docx` is on PATH. Native CX RAI uses its own Windows skill and bootstrap, never these Linux paths.

Read only relevant sections of `SKILL_DIR/SKILL.md` and `references/commands.md` with bounded `sandbox_exec` reads. Start with `docx --help` and the needed subcommand help; do not guess flags. The sandbox is offline: do not run upstream installers or download packages. Work below `/workspace`; preserve the tool's input-name mapping and original documents.

For a new report, write a complete Markdown draft and immediately create an actual DOCX checkpoint: `docx create report.docx --from draft.md`. Then batch style changes, images, tables, margins, headers/footers and page numbers. Avoid dozens of tiny JSONL edits before any DOCX exists. Save the DOCX after meaningful stages. Markdown drafts and edit logs are not completed Word documents.

For existing documents, read first to obtain real paragraph/character/table locators; change only the requested region. Re-read locators after structural edits. Use native track changes and comments when requested, and verify they exist; colored text does not replace revisions. Keep the original, return a new copy.

Embed user-provided images in the DOCX itself; captions do not replace pictures. Before delivery, verify each requested image has nonempty media bytes and a drawing relationship in the final saved DOCX. A failed copy or insertion leaves an unfinished draft. Inspect supplied source folders before deciding which materials to include.

Check the resulting DOCX with `docx read`, verify the ZIP/XML package, and use `libreoffice --headless` to render PDF when layout matters. Inspect available rendered output for pagination, tables, headers and overflow. State visual checks that could not be performed. Publish the final DOCX through `sandbox_exec.output_path`; the UI supplies its real download reference. Do not claim completion after a failed command.

`python3` also has python-docx for supported creation tasks. Prefer docx-cli when preserving complex existing formatting, revisions or comments. Upstream notices: `SKILL_DIR/LICENSE`, `NOTICES`, `LGPL-3.0.txt`.
