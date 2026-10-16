# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Codex, Cursor and others) when working with code in this repository.

## What this is

A local PDFreactor setup for rendering Simple Reporting Library (srl, `@simple-reporting/base`) projects to PDF. Two parts:

- **`bin/pdf-reactor`** (bash): manages the PDFreactor web service in Docker (`docker/docker-compose.yml`, image `realobjects/pdfreactor`, container `pdfreactor`, port 9423). It is symlinked to `~/.local/bin/pdf-reactor`, so the script resolves its own location by following the symlink (portable, no `readlink -f` because older macOS lacks it). Keep the script compatible with macOS bash 3.2. Never assume the cwd is this repo.
- **`scripts/local-pdf.mjs`** (Node, no dependencies, ESM): runs `build-pdf` in an srl project, serves the result through a small local HTTP server, and posts the URL to PDFreactor's REST API (`/service/rest/convert.pdf`).

There is no build, lint or test setup. To check changes, run the commands against a real srl project.

## Commands

```bash
pdf-reactor start | stop | restart | reload | status | logs -f | shell | update | down
pdf-reactor pdf [--skip-build] [--lang de] [--no-js] [--mode export|content]   # run inside an srl project → .output/pdf-reactor/report.pdf
pdf-reactor watch                                      # re-renders on changes, latest at http://127.0.0.1:4175/latest.pdf
pdf-reactor components                                 # all livingdocs components → components.pdf
pdf-reactor file <path>                                # one HTML file → generated.pdf
bash -n bin/pdf-reactor && node --check scripts/local-pdf.mjs   # syntax check
```

`pdf-reactor help` lists every option. When you add a CLI option, update `usage()` in `bin/pdf-reactor` and `parseArgs()` in `local-pdf.mjs`. `parseArgs()` throws on unknown arguments.

## Architecture and non-obvious behavior

- **Config is only read at startup.** `config/` is mounted to `/ro/config` and holds `pdfreactorwebservice.config` and `licensekey.txt` (gitignored; without it PDFreactor runs in evaluation mode). Changes to these files or to the compose file need `reload` (`up -d --force-recreate`). `restart` is not enough.
- **Foreign container cleanup:** every lifecycle command calls `remove_foreign_container`, which deletes a container named `pdfreactor` from a different compose file (for example an old copy under `~/projects`).
- **Networking (WSL/Docker):** PDFreactor fetches the document from the host via `host.docker.internal` (`extra_hosts: host-gateway` for native Linux Docker). `-Djava.net.preferIPv4Stack=true` is needed because the IPv6 address does not work. The local server listens on `0.0.0.0:4175`, so `isServable()` only serves `.output`, `public`, `src`, `livingdocs` and the first segment of `--public-base` (no dot segments below them), and stack traces only go to loopback clients. The PDFreactor port itself is bound to `127.0.0.1`. `renderPdf` retries up to 5 times when the response says `http host connect` / `HttpHostConnectException` (checked before the `!response.ok` throw, PDFreactor 12 answers with 422), because a newly opened port can take a moment to become reachable from Docker Desktop.
- **Project root resolution:** in this order: `PDFREACTOR_PROJECT_ROOT`, then the nearest `package.json` at or above `INIT_CWD`/cwd. All `--` path options are relative to that srl project, not to this repo.
- **Wrapper document:** the server builds `/__local-pdf.html` on the fly. In content mode it wraps every `*.html` in `<sourceDir>/<lang>` (default `public/html`, fallback `public/pdf/web/html`, sorted numerically) in `<article class="srl-local-pdf-article">`. It sets `<base href>` to `--public-base` (default `public/exclude/web`) and loads `/.output/pdf/pdf.css` and `pdf.js`. A copy of the last wrapper is written to `.output/pdf-reactor/last-wrapper.html` for debugging. A non-PDF response is saved to `last-pdfreactor-response.bin`.
- **Export mode** (default when `public/json/routing_<lang>.json` exists, else content mode): `buildExportHtml` rebuilds the document ns.wow sends to PDFreactor from the web export in `public/`. Verified against a real ns.wow export (`nsg/nsfd_report-demo-mms/public/exclude`): 47 of 53 articles match byte for byte apart from image URLs, `pdf.css`/`pdf.js` are identical. Rules: no doctype, `body.pdf`, publication title from `settings.json`, one `div.srl-chapter srl-<slug of the menuMain label in defaultLanguage>` per main menu entry, one `div.srl-article srl-<cssName(page.name)>` per page (single-quoted attributes, trailing space in the class like ns.wow), category pages (`srl-category-accordion--category`) expand to their member pages with `srl-category-<page name>` (category ids are mapped by matching accordion titles), chapter navigation at the start of each chapter's first article, `pdf.css`/`pdf.js` inline in the head, `<base href="/public/">`. `writeExportDocument` writes the finished document to `.output/pdf-reactor/document-<lang>.html` and PDFreactor loads that file (no preflight of `/__local-pdf.html` in this mode). The source (`--source-dir`) can be the raw ns.wow export with all `data-remove-from-*` still in it; ns.wow applies `data-remove-from-pdf` and `data-replace-tag` for the PDF and keeps the other `data-remove-from-*` attributes, and so does `toPdfHtml`. It `data-remove-from-pdf` (complete/transient), `data-replace-tag`, rewrites `data-article-name` links to `#anchor` / `#srl-article-id-<uuid>` and drops `loading="lazy"`; tags without these attributes are copied verbatim. `public/json/pdf_structure.json` (chapters with Livingdocs id and name, articles with id, page name, uuid, category; not an ns.wow format, reconstructed in `nsg/nsfd_report-demo-mms/public/exclude/raw`) replaces the menuMain structure when present (`readStructureFile`): exact ids, chapters outside the menu, navigation only for chapters whose name is the slug of a menuMain label. With the reconstructed raw export the document matches the reference in all 75 chapter/article blocks except image URLs. Without it, ids use the routing uuid / chapter slug. `public/html` is the web version (`data-remove-from-web` already applied), so PDF-only articles (covers, TOC, chapter covers, imprint, backcover) and PDF-only components (`srl-pdf-pagebreak`, `srl-pdf-landscape-container`) are missing.
- **Fonts** come only from the project, there is no server-wide fonts folder. `build-pdf` writes them to `.output/fonts/style.css`. The server rewrites the font URLs with `?v=<mtime>`, because PDFreactor caches fonts by URL (failed downloads too).
- **Build call:** `npm run build-pdf -- --no-clean`, using the package manager from `npm_execpath` or the lockfile. `--no-clean` keeps the rest of `.output`.
- **PDFreactor config:** `--config` (default `pdf/pdf-configuration-debug.xml` in the project) is not sent as a whole. `readPdfreactorXmlConfig` takes only `addTags`, `appendLog`, `debugSettings/all`, `inspectableSettings/enabled` and `viewerPreferences` with regexes. To support more settings, extend that function.
- **Timeouts:** the POST uses `node:http` with `setTimeout(0)` instead of `fetch`, because undici gives up after 300 s without headers and full reports can take longer.
- **Project-specific hardcoding:** `components` mode nests child components into parents through `childComponentsByParent` (livingdocs folder names such as `010.unordered-list`). `file` mode rewrites `https://nswow-ld.nswow.ch/images/...` URLs to local `images/`. Both are written for the nswow project. `--no-js` imitates the nswow editor PDF preview.
