---
alwaysApply: true
description: Use code_search for intent-based code search instead of shell greps.
---

# Code search (colgrep)

- `code_search` is the default way to find code by behavior, concept, or intent. Pass a natural-language `query`; do not translate it into grep syntax first.
- Combine `query` with `pattern` for text plus meaning. Use `pattern` alone for a literal or regex search that still needs relevance ranking.
- Raise `results` to 20-30 when exploring an unfamiliar subsystem; keep it small for precise questions.
- Use the native `grep` tool only for exact regexes, `omp://` or `skill://` URLs, archive members, or line ranges. Use `glob` for file names.
- Use `code_agent` for vague "where is this implemented" questions after one `code_search`, or when you need a shortlist of files without reading them.
- Run `grep`, `rg`, `ag`, or `ack` through bash only for stdin filtering, flags colgrep lacks (`-v`, `-c`, `-o`), or scopes colgrep does not index.
- Ranked results are not evidence of absence: rephrase the query or use `pattern` before concluding code does not exist.
