---
name: presentations
description: PowerPoint PPTX creation and editing.
---

# PowerPoint — PPT Master

Use hugohe3/ppt-master 6.8.0, pinned to the same commit as CX RAI. Complete guides, templates, icons and scripts are read-only at `/skills/presentations` (SKILL_DIR). Native CX RAI uses its own Windows resource path.

Read relevant parts of `SKILL_DIR/SKILL.md` with bounded `sandbox_exec` reads, then only references needed for the requested workflow. Follow upstream planning, design, SVG authoring, validation and editable PPTX export. Use template/brand/layout assets as appropriate. Work below `/workspace`; never unpack the icon collection into the user's bounded workspace.

Read actual scripts' `--help` before choosing flags. `python3` has python-pptx, Pillow, CairoSVG, PyYAML and XlsxWriter. No package installation, network image generation or narration download is available inside this offline sandbox; use supplied images or server fetch/image tools. Keep upstream attribution requirements and `SKILL_DIR/LICENSE`.

Make the deck visually intentional: coherent theme, clear hierarchy, balanced layouts, legible typography, useful graphics and consistent spacing. Avoid slides made only of titles and default bullets. Export an actual editable PPTX, verify ZIP integrity and expected slide count, render preview/PDF pages with available CairoSVG or LibreOffice, and check clipping, overlap and contrast. State visual checks you could not perform.

Set `sandbox_exec.output_path` to the final PPTX, or a ZIP containing the deck and requested supporting outputs. Deliver the real artifact returned by the tool.
