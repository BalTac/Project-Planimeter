## graphify

For any question about this repo's architecture, structure, components, or how to add/modify/find
code, your first action should be `graphify query "<question>"` when `graphify-out/graph.json`
exists. Use `graphify path "<A>" "<B>"` for relationship questions and `graphify explain "<concept>"`
for focused-concept questions. These return a scoped subgraph, usually much smaller than the full
report or raw grep output.

Triggers: "how do I…", "where is…", "what does … do", "add/modify a <component>",
"explain the architecture", or anything that depends on how files or classes relate.

If `graphify-out/wiki/index.md` exists, use it for broad navigation. Read `graphify-out/GRAPH_REPORT.md`
only for broad architecture review or when query/path/explain do not surface enough context. Only read
source files when (a) modifying/debugging specific code, (b) the graph lacks the needed detail, or
(c) the graph is missing or stale.

Type `/graphify` in Copilot Chat to build or update the graph.

## Language conventions

**Internal code is English-only.** Use English for everything that is not directly user-facing:
- variable, function, class, file, module, and directory names
- code comments and docstrings
- commit messages, PR descriptions, branch names
- internal documentation: `README.md`, `CHANGELOG.md`, `TODO_LIST.md`, files under `wiki/`, `raw/`,
  `.github/`, `domains/*.json` keys/ids, repo memory notes, design specs, ADRs
- log messages, error strings emitted by the backend, test names and assertions

**Italian (and other locales) is reserved for the UX layer only**, i.e. strings rendered to the
end user through the i18n system in `src/i18n/` (`it.js`, `en.js`, future locales). Add new
user-visible text as i18n keys (`t('namespace.key')`) — never hard-code localized strings in
component logic. Translations live in the locale files; default key fallback must be English.

This applies to new code and to any text you author. You may convert Italian identifiers or
comments to English only within the file or function you are already editing for the primary task;
do not perform large-scale renames as a side effect of unrelated work.

## Operating system conventions

**You are on a Windows system using PowerShell.** Always write file paths with forward slashes
(`/`) as separators in source code, documentation, terminal commands, and tool arguments.
For example, write `src/io/history.js` (never `src\io\history.js`).
