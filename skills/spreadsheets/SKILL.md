---
name: spreadsheets
description: Excel XLSX and CSV creation, formulas and validation.
---

# Excel — Hermes and Bread

Use the same pinned NousResearch/hermes-agent Office skill and Bread-Technologies/Bread_Excel_Agent resources as CX RAI. They are read-only at `/skills/spreadsheets` (SKILL_DIR). Native CX RAI supplies its own Windows SKILL_DIR.

For normal XLSX/CSV work, read relevant sections of `SKILL_DIR/hermes/SKILL.md` and `hermes/references/excel.md`. Use `hermes/scripts/xlsx_*.py` helpers or installed openpyxl via `python3`. Read the chosen helper's `--help` first. For finer cell/chart/conditional-format operations, read only needed Bread definitions in `bread/excel_action_space/tools/definitions.json` and its openpyxl executor. Excel automation/Windows-only integrations in upstream examples are unavailable on this Linux server.

Work offline below `/workspace`. Preserve originals and return a new copy. Use real formulas for calculations; apply suitable number formats, widths, headers, freeze panes, filters and charts. Separate inputs and computed values. Never invent source data or replace requested formulas with unlabelled constants.

Reopen generated workbooks and verify sheet names, dimensions, cell types, styles, formulas and charts. openpyxl does not calculate results: use LibreOffice when recalculation or cached values are required, and inspect formula errors. Do not claim recalculation solely because a formula string was written. Check visible layout with a render when available.

Publish the completed XLSX/CSV through `sandbox_exec.output_path`. Preserve upstream MIT licenses at `hermes/LICENSE` and `bread/LICENSE`.
