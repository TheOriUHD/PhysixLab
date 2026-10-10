# UI extensions

Every `*.ts` file in this folder is imported when the app starts, after the built-in commands, tools, menus, panels
and inspector sections are registered. A file registers what it adds by calling the functions of
`src/app/registry` (`registerCommand`, `registerTool`, `registerPanel`, `registerInspectorSection`,
`registerMenuEntry` …) and needs no other edit anywhere. A file that throws while loading is reported with a
toast and skipped; the rest of the app starts normally.

See `docs/EXTENDING.md` for complete, tested examples.
