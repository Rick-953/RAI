# Adaptive interactions in beta 0.13.53

Chat remains the main surface. The desktop workspace starts closed, opens for new task components or an explicit user action, and contains component data rather than an automatic copy of the entire answer. Mobile renders components between the original prose segments and has no workspace drawer.

The existing RAI theme, radii and motion variables remain authoritative. Both desktop columns have pointer and keyboard resize handles. Only sidebar collapse and the two requested widths are stored in device-local storage, scoped to the application base path. Workspace openness is not saved as a global default.

## Component protocol

The model emits a standalone `rai_visual` JSON fence. The shared schema validates exact fields, bounds, dates and numeric steps before rendering. It accepts budget, comparison, checklist and form components. Forms expose button, checkbox, radio, segmented control, select, slider with numeric entry, input, textarea, date, popover, carousel, pressable card and accessible badge controls.

Each component has a stable ID. A later complete component with the same ID replaces the active version. A `{ "type": "remove", "id": "..." }` directive removes an obsolete component. Assistant history remains intact. Invalid fences remain readable code rather than running as UI.

Controls use DOM text nodes and native input semantics; model output cannot supply HTML, executable callbacks or network actions. User edits update local state. Confirmation fills the composer, and the user sends the follow-up. Validated current values accompany subsequent requests as untrusted user context, including the managed Agent path. Edits are isolated by conversation and message identity; historical cards cannot change the current version. Draft control edits remain in memory until leaving the conversation or reloading, while definitions recover from saved messages.

## Tool completion

One completed result batch counts as one tool round. Parallel tools in the same batch count once; provider retries and interjection-only continuations do not count. Up to eight rounds finish with one normal answer. Nine or more allow one final summary after the required work, using the natural continuation rather than an additional summary request. Previously displayed assistant text is retained in subsequent tool context, including Gemini conversion.

Once parallel Agent output or tool dispatch has started, a later exception goes through the existing error finalizer and cannot restart the task as a single model.

## Verification

- Shared schema, fence parser, current-state validation and same-ID replacement/removal regressions.
- Chromium and WebKit: all controls, normal pointer/keyboard interaction, 320px/368px layouts, themes, forms, draft callbacks and error feedback.
- Full application: automatic partial pins, mobile prose order, resizing/device reload, rail, stream finalization, delayed conversation navigation and source-ID migration.
- Linux isolated HTTP/SSE integration with real authentication and SQLite, local provider fixture and no external model requests.
- Tool round 0/2/3/8/9 boundaries, retry/batch semantics, one rendered answer and twelve parallel failure/replay scenarios.

Provider fixtures establish protocol and application behavior. They do not establish how consistently every live model follows the component-selection instructions, or physical installed-iOS acceptance.
