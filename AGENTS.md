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
- **Export mode** (default when `public/json/routing_<lang>.json` exists, else content mode): `buildExportHtml` rebuilds the document ns.wow sends to PDFreactor from the export in `public/`. `writeExportDocument` writes it to `.output/pdf-reactor/document-<lang>.html` and PDFreactor loads that file (no preflight of `/__local-pdf.html` in this mode). Document: no doctype, `body.pdf`, publication title from `settings.json`, `pdf.css`/`pdf.js` inline in the head, `<base href="/public/">`, one `div.srl-chapter` per chapter, one `div.srl-article srl-<cssName(page.name)>` per page (single-quoted attributes, trailing space in the class like ns.wow), `srl-category-<category page>` on category members.
  - **Structure** (`readExportStructure`): the menu is app-only and not used. Order = page file names sorted numerically, one chapter per leading number; left out are `excludeFromPdf` pages, category overview pages (`srl-category-accordion--category`) and empty files; category membership comes from the routing (`resolveCategories`, ids mapped by matching accordion titles). A chapter with a `srl-pdf-chapter-cover` is named after the cover title and gets the chapter navigation (running header) in its first article, like ns.wow. `public/json/pdf_structure.json` (chapters with Livingdocs id and name, articles with id, page name, uuid, category; not an ns.wow format, reconstructed in `nsg/nsfd_report-demo-mms/public/exclude/raw`) overrides order and adds the exact ids and chapter names; without it ids are the routing uuid / chapter slug and chapters without cover are `chapter-<nn>`. Both ways match the ns.wow reference in all 75 chapter/article blocks (except ids/names without the file and image URLs).
  - **PDF rules** (`toPdfHtml`): the source (`--source-dir`, default `public/html`) can be the raw ns.wow export with all `data-remove-from-*` or the web export (then PDF-only articles and components are missing, a warning says so). Like ns.wow it applies `data-remove-from-pdf` (complete/transient) and `data-replace-tag`, keeps the other `data-remove-from-*`, rewrites `data-article-name` links to `#anchor` / `#srl-article-id-<id>` and drops `loading="lazy"`; tags without these attributes are copied verbatim.
- **Fonts** come only from the project, there is no server-wide fonts folder. `build-pdf` writes them to `.output/fonts/style.css`. The server rewrites the font URLs with `?v=<mtime>`, because PDFreactor caches fonts by URL (failed downloads too).
- **Build call:** `npm run build-pdf -- --no-clean`, using the package manager from `npm_execpath` or the lockfile. `--no-clean` keeps the rest of `.output`.
- **PDFreactor config:** `--config` (default `pdf/pdf-configuration-debug.xml` in the project) is not sent as a whole. `readPdfreactorXmlConfig` takes only `addTags`, `appendLog`, `debugSettings/all`, `inspectableSettings/enabled` and `viewerPreferences` with regexes. To support more settings, extend that function.
- **Timeouts:** the POST uses `node:http` with `setTimeout(0)` instead of `fetch`, because undici gives up after 300 s without headers and full reports can take longer.
- **Project-specific hardcoding:** `components` mode nests child components into parents through `childComponentsByParent` (livingdocs folder names such as `010.unordered-list`). `file` mode rewrites `https://nswow-ld.nswow.ch/images/...` URLs to local `images/`. Both are written for the nswow project. `--no-js` imitates the nswow editor PDF preview.
