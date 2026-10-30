import { createServer, request as httpRequest } from 'node:http'
import { createReadStream, existsSync, promises as fs, readdirSync, statSync } from 'node:fs'
import { watch } from 'node:fs'
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'

const root = findProjectRoot()
const outputDir = join(root, '.output', 'pdf-reactor')
const fontStylesheetPath = '/.output/fonts/style.css'
// npm_execpath points to the package manager's JS entry (e.g. npm-cli.js), so run it through node
const packageManager = process.env.npm_execpath
  ? { command: process.execPath, args: [process.env.npm_execpath] }
  : { command: detectPackageManager(), args: [] }

const options = parseArgs(process.argv.slice(2))

console.log(`Project ${root} (${options.mode} mode)`)

let server
let running = false
let queued = false

if (options.watch) {
  await runOnce()
  watchForChanges()
} else {
  await runOnce()
  await closeServer()
}

async function runOnce() {
  if (running) {
    queued = true
    return
  }

  running = true
  queued = false

  try {
    if (!options.skipBuild) {
      // build-pdf also writes the project fonts to .output/fonts. --no-clean keeps the rest of
      // .output (design.zip, pdf-configuration.xml of the last full build, earlier local PDFs)
      const customerArgs = options.customer ? ['--customer', options.customer] : []
      await runCommand(packageManager.command, [...packageManager.args, 'run', 'build-pdf', '--', '--no-clean', ...customerArgs])
    }

    await fs.mkdir(outputDir, { recursive: true })

    const port = await ensureServer()
    const documentPath = options.mode === 'export'
      ? await writeExportDocument(options.lang)
      : `/__local-pdf.html?lang=${encodeURIComponent(options.lang)}`
    const documentUrl = `http://${options.documentHost}:${port}${documentPath}`

    if (options.mode !== 'export') {
      await preflightDocument(`http://127.0.0.1:${port}${documentPath}`)
    }

    // documentUrl is how the container reaches this machine, host.docker.internal does not
    // resolve in the browser. localhost does, also from Windows into WSL
    console.log(`Rendering ${documentPath}`)
    const pdf = await renderPdf(documentUrl)
    const outputFile = getOutputFile()
    await fs.writeFile(outputFile, pdf)
    console.log(`Wrote ${relative(root, outputFile)}`)
    if (options.watch) {
      console.log(`Document in the browser: http://localhost:${port}${documentPath}`)
      console.log(`Latest PDF: http://localhost:${port}/latest.pdf`)
    } else {
      const documentFile = options.mode === 'export' ? `document-${options.lang}.html` : 'last-wrapper.html'
      console.log(`HTML sent to PDFreactor: ${relative(root, join(outputDir, documentFile))} (to open it in the browser, use watch: the local server only runs while rendering)`)
    }
  } finally {
    running = false

    if (queued) {
      await runOnce()
    }
  }
}

async function preflightDocument(documentUrl) {
  const response = await fetch(documentUrl)
  const body = await response.text()
  await fs.writeFile(join(outputDir, 'last-wrapper.html'), body)

  if (!response.ok) {
    throw new Error(`Local PDF wrapper failed with ${response.status}:\n${body}`)
  }
}

async function renderPdf(documentUrl, attempt = 1) {
  const configuration = {
    document: documentUrl,
    documentType: 'HTML5',
    addTags: true
  }

  if (options.config) {
    Object.assign(configuration, await readPdfreactorXmlConfig(options.config))
  }

  // Like the nswow PDF preview next to the editor, which runs no JavaScript
  if (options.noJs) {
    configuration.javaScriptSettings = { disabled: true }
  }

  const { response, responseBody } = await postWithoutTimeout(options.pdfreactorUrl, JSON.stringify(configuration))

  // Under WSL a freshly opened port takes a moment to become reachable from Docker Desktop.
  // PDFreactor 12 reports that as 422 "http host connect", older versions as HttpHostConnectException
  if (attempt < 5 && /HttpHostConnectException|http host connect/i.test(responseBody.toString('utf8'))) {
    console.log(`PDFreactor could not reach the local server yet, retrying (${attempt}/5)...`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000))
    return renderPdf(documentUrl, attempt + 1)
  }

  if (!response.ok) {
    const message = responseBody.toString('utf8')
    throw new Error(`PDFreactor failed with ${response.status}: ${message}`)
  }

  const pdf = extractPdfResponse(response, responseBody)

  if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    const debugFile = join(outputDir, 'last-pdfreactor-response.bin')
    await fs.writeFile(debugFile, responseBody)
    throw new Error(`PDFreactor response was not a PDF. Saved raw response to ${relative(root, debugFile)}`)
  }

  return pdf
}

/*
  POST to PDFreactor without a time limit. fetch() gives up after 300 s without
  response headers (undici headersTimeout), the full report with all PDF
  scripts can take longer. Returns a fetch-like response (ok, status, headers.get).
*/
function postWithoutTimeout(url, body) {
  return new Promise((resolvePost, rejectPost) => {
    const req = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          accept: 'application/pdf',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body)
        }
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolvePost({
            response: {
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              headers: { get: (name) => res.headers[name.toLowerCase()] ?? null }
            },
            responseBody: Buffer.concat(chunks)
          })
        )
        res.on('error', rejectPost)
      }
    )
    req.setTimeout(0)
    req.on('error', rejectPost)
    req.end(body)
  })
}

function extractPdfResponse(response, responseBody) {
  if (responseBody.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    return responseBody
  }

  const contentType = response.headers.get('content-type') || ''
  const text = responseBody.toString('utf8').trim()

  if (contentType.includes('json') || text.startsWith('{')) {
    const result = JSON.parse(text)
    const document = result.document || result.documentData

    if (typeof document === 'string') {
      return Buffer.from(document, 'base64')
    }
  }

  return responseBody
}

async function ensureServer() {
  if (server) {
    return options.port
  }

  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${options.port}`)

      if (url.pathname === '/__local-pdf.html') {
        const html = await buildHtml(url.searchParams.get('lang') || options.lang)
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(html)
        return
      }

      if (url.pathname === '/latest.pdf') {
        await servePdf(getOutputFile(), response)
        return
      }

      if (url.pathname === fontStylesheetPath) {
        await serveFontStylesheet(response)
        return
      }

      await serveFile(url.pathname, response)
    } catch (error) {
      // The server listens on all interfaces so the container can reach it,
      // only local requests (the preflight) get the stack trace
      console.error(error)
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(isLoopback(request.socket.remoteAddress)
        ? (error instanceof Error ? error.stack : String(error))
        : 'Internal server error')
    }
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(options.port, '0.0.0.0', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })

  return options.port
}

async function servePdf(filePath, response) {
  const stat = await fs.stat(filePath).catch(() => null)

  if (!stat?.isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(`No generated PDF found at ${relative(root, filePath)}`)
    return
  }

  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-disposition': `inline; filename="${basename(filePath)}"`,
    'content-type': 'application/pdf'
  })
  createReadStream(filePath).pipe(response)
}

async function buildHtml(lang) {
  const fontLink = fontStylesheetLink()
  const customerAssets = await customerHeadAssets()
  if (options.mode === 'file') {
    return buildSingleFileHtml(fontLink, customerAssets)
  }

  if (options.mode === 'export') {
    return buildExportHtml(lang, fontLink, customerAssets)
  }

  const content = options.mode === 'components'
    ? await buildComponentGallery()
    : await buildContentArticles(lang)

  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
  <meta charset="utf-8">
  <base href="/${toUrlPath(options.publicBase)}/">
  <style>
${galleryCss()}
  </style>
  ${fontLink}
  <link rel="stylesheet" href="/.output/pdf/pdf.css">
  <script src="/.output/pdf/pdf.js" defer></script>
  ${customerAssets}
  <title>Local PDF</title>
</head>
<body>
${content}
</body>
</html>`
}

async function buildContentArticles(lang) {
  const htmlDir = await resolveSourceDir(lang)
  const files = (await fs.readdir(htmlDir))
    .filter((file) => file.endsWith('.html'))
    .sort((a, b) => a.localeCompare(b, 'de-CH', { numeric: true }))

  const articles = await Promise.all(files.map(async (file) => {
    const body = await fs.readFile(join(htmlDir, file), 'utf8')
    return `<article class="srl-local-pdf-article" data-source="${escapeHtml(file)}">${body}</article>`
  }))

  return articles.join('\n')
}

async function resolveSourceDir(lang) {
  const configured = join(root, options.sourceDir, lang)
  const fallback = join(root, 'public', 'pdf', 'web', 'html', lang)

  if (await isDirectory(configured)) {
    return configured
  }

  if (await isDirectory(fallback)) {
    return fallback
  }

  throw new Error(`Could not find PDF HTML source directory. Checked ${relative(root, configured)} and ${relative(root, fallback)}`)
}

/*
  Rebuilds the document ns.wow sends to PDFreactor from the export in public/: publication
  title, one div.srl-chapter per chapter and one div.srl-article per page, pdf.css and
  pdf.js inline in the head like in the ns.wow export. The page HTML can be the raw export (all
  data-remove-from-* still in it) or the web version (data-remove-from-web already applied, so
  PDF-only components are missing). Either way the pdf rules are applied here.
*/
async function buildExportHtml(lang, fontLink, customerAssets = '') {
  const structure = await readExportStructure(lang)
  const htmlDir = await resolveSourceDir(lang)
  const articleIds = new Map(structure.chapters.flatMap((chapter) => chapter.articles).map((article) => [article.page.uuid, articleId(article)]))
  const stats = { complete: 0, transient: 0, replaced: 0, pdfOnly: 0 }

  const chapters = await Promise.all(structure.chapters.map(async (chapter) => {
    const articles = await Promise.all(chapter.articles.map(async ({ page, category, id }, index) => {
      const file = join(htmlDir, `${page.name}.html`)
      const body = existsSync(file) ? await fs.readFile(file, 'utf8') : ''
      const name = cssName(page.name)
      const categoryClasses = category ? `srl-category-${category} ns-category-${category}` : ''
      const navigation = index === 0 && chapter.label ? chapterNavigation(structure.chapters, chapter) : ''
      return `<div class='srl-article ns-article srl-${name} ns-${name} ${categoryClasses}' id='${articleId({ page, id })}' lang='${escapeHtml(lang)}'>${navigation}${toPdfHtml(body, articleIds, stats)}</div>`
    }))
    return `<div class='srl-chapter ns-chapter srl-${chapter.slug} ns-${chapter.slug}' id='${chapterId(chapter)}'>${articles.join('')}</div>`
  }))

  console.log(`PDF rules: ${stats.complete} elements removed, ${stats.transient} unwrapped, ${stats.replaced} tags replaced`)
  if (stats.pdfOnly === 0) {
    console.warn(`No data-remove-from-web in ${relative(root, htmlDir)}: this is the web export, PDF-only components are missing`)
  }

  const [css, js] = await Promise.all([
    fs.readFile(join(root, '.output', 'pdf', 'pdf.css'), 'utf8'),
    fs.readFile(join(root, '.output', 'pdf', 'pdf.js'), 'utf8')
  ])

  // No doctype and the script in the head, like the ns.wow export
  return `<html lang="${escapeHtml(lang)}"><head><meta charset="UTF-8" /><base href="/public/">${fontLink}<style>${css}</style><script>${js}</script>${customerAssets}<title>${escapeHtml(structure.title)}</title></head><body class="pdf"><p class='srl-pdf-publication-title lc-pdf-publication-title'><span class='srl-pdf-publication-title__text lc-pdf-publication-title__text'>${escapeHtml(structure.title)}</span></p>${chapters.join('')}</body></html>`
}

/*
  Export mode writes the finished document (pdf rules applied) to .output/pdf-reactor and
  PDFreactor loads that file, so the HTML that went into the PDF stays next to it
*/
async function writeExportDocument(lang) {
  const file = join(outputDir, `document-${lang}.html`)
  await fs.writeFile(file, await buildExportHtml(lang, fontStylesheetLink(), await customerHeadAssets()))
  console.log(`Wrote ${relative(root, file)}`)
  return `/${toUrlPath(relative(root, file))}`
}

/*
  Order and chapters come from the page names, not from the app menu: the files of the source dir
  sorted by their numbers ("01_02 …" before "01_10 …"), one chapter per leading number (00, 01, …,
  99). Left out: pages with excludeFromPdf, category overview pages and empty files. When
  public/json/pdf_structure.json exists, it sets chapters, order and Livingdocs ids instead.
  A chapter with a chapter cover is named after the cover title and gets the chapter navigation,
  like in the ns.wow export.
*/
async function readExportStructure(lang) {
  const settings = await readJson(join(root, 'public', 'json', 'settings.json'))
  const routing = await readJson(join(root, 'public', 'json', `routing_${lang}.json`))
  const htmlDir = await resolveSourceDir(lang)
  const pages = new Map(routing.pages.map((page) => [page.name, page]))
  // Pages that are only in the PDF are not in the routing; uuid like the routing ones
  const pageOf = (name, uuid) => pages.get(name) ?? { name, uuid: uuid ?? slugify(name) }
  const structureFile = join(root, 'public', 'json', 'pdf_structure.json')
  let chapters

  if (existsSync(structureFile)) {
    chapters = (await readJson(structureFile)).chapters.map((chapter) => ({
      id: chapter.id,
      slug: chapter.name,
      articles: chapter.articles.map((article) => ({ page: pageOf(article.name, article.uuid), category: article.category, id: article.id }))
    }))
  } else {
    const { categoryOf, categoryPages } = await resolveCategories(routing.pages, lang)
    const names = (await fs.readdir(htmlDir))
      .filter((file) => file.endsWith('.html') && statSync(join(htmlDir, file)).size > 0)
      .map((file) => file.slice(0, -5))
      .filter((name) => !categoryPages.has(name) && !pages.get(name)?.excludeFromPdf)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    const byNumber = new Map()

    for (const name of names) {
      const number = /^\d+/.exec(name)?.[0]
      if (!number) {
        console.warn(`No leading number, left out of the PDF: ${name}`)
        continue
      }
      if (!byNumber.has(number)) byNumber.set(number, { slug: `chapter-${number}`, articles: [] })
      const page = pageOf(name)
      byNumber.get(number).articles.push({ page, category: categoryOf.get(page.uuid) })
    }
    chapters = [...byNumber.values()]
  }

  for (const chapter of chapters) {
    chapter.articles = chapter.articles.filter(({ page }) => !page.excludeFromPdf)
    chapter.label = await chapterCoverTitle(htmlDir, chapter.articles)
    if (chapter.label && !chapter.id) chapter.slug = slugify(chapter.label)
  }

  return {
    title: settings.publicationName?.[lang] || '',
    chapters: chapters.filter((chapter) => chapter.articles.length > 0)
  }
}

async function chapterCoverTitle(htmlDir, articles) {
  for (const { page } of articles) {
    const file = join(htmlDir, `${page.name}.html`)
    if (!existsSync(file)) continue
    const match = /class="srl-pdf-chapter-cover__title__text"[^>]*>([^<]*)</.exec(await fs.readFile(file, 'utf8'))
    if (match) return decodeEntities(match[1]).trim()
  }
  return ''
}

/*
  routing_<lang>.json only has category ids (categories.references[].id), not which page shows
  the category. A category page lists its members as accordions (srl-category-accordion__head-text),
  so each id goes to the category page whose accordion titles match most of its members.
*/
async function resolveCategories(routingPages, lang) {
  const htmlDir = await resolveSourceDir(lang)
  const membersById = new Map()

  for (const page of routingPages) {
    for (const { id } of page.categories?.references ?? []) {
      if (!membersById.has(id)) membersById.set(id, [])
      membersById.get(id).push(page)
    }
  }

  const categoryPages = []
  for (const page of routingPages) {
    const file = join(htmlDir, `${page.name}.html`)
    if (page.categories || !existsSync(file)) continue
    const html = await fs.readFile(file, 'utf8')
    if (!html.includes('srl-category-accordion--category')) continue
    const titles = new Set([...html.matchAll(/srl-category-accordion__head-text">([^<]*)</g)].map((match) => decodeEntities(match[1]).trim()))
    categoryPages.push({ name: page.name, titles })
  }

  const categoryOf = new Map()
  for (const [id, members] of membersById) {
    const best = categoryPages
      .map((categoryPage) => ({ name: categoryPage.name, score: members.filter((member) => categoryPage.titles.has(member.translatedTitle)).length }))
      .sort((a, b) => b.score - a.score)[0]

    if (!best || (best.score === 0 && categoryPages.length > 1)) {
      console.warn(`Could not find the page of category ${id}, its pages are placed like normal pages`)
      continue
    }

    for (const member of members) categoryOf.set(member.uuid, best.name)
  }

  return { categoryOf, categoryPages: new Set(categoryPages.map((categoryPage) => categoryPage.name)) }
}

/*
  ns.wow lists the chapters with a chapter cover as chapter navigation at the start of their first
  article, pdf.css makes it the running header with the current chapter highlighted
*/
function chapterNavigation(chapters, current) {
  const items = chapters.filter((chapter) => chapter.label).map((chapter) => {
    const currentClasses = chapter === current ? ' srl-chapter-navigation__list-item--current lc-chapter-navigation__list-item--current' : ''
    return `<li class='lc-chapter-navigation__list-item srl-chapter-navigation__list-item${currentClasses}'><a href='#${chapterId(chapter)}'>${escapeHtml(chapter.label)}</a></li>`
  })
  return `<div class='srl-chapter-navigation lc-chapter-navigation'><ol class='srl-chapter-navigation__list lc-chapter-navigation__list'>${items.join('')}</ol></div>`
}

// Livingdocs ids come from pdf_structure.json, without it the routing uuid / chapter slug takes their place
function articleId({ page, id }) {
  return `srl-article-id-${id ?? page.uuid}`
}

function chapterId(chapter) {
  return `srl-chapter-id-${chapter.id ?? chapter.slug}`
}

// "05_06_14 Property, Plant and Equipment" -> "05_06_14_property_plant_and_equipment"
function cssName(name) {
  return name.toLowerCase().replaceAll(' ', '_').replace(/[^\w-]/g, '')
}

function slugify(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/*
  Applies what ns.wow does for the PDF: data-remove-from-pdf="complete" drops the element,
  "transient" keeps only its children, data-replace-tag renames the element. The attributes
  for the other outputs (data-remove-from-web, -word, -xhtml) stay, like in the ns.wow export.
  Links to other pages (data-article-name) point to the anchor or the article in the document,
  and loading="lazy" goes away, so the result matches the ns.wow export byte for byte except
  for image URLs. Tags without these attributes are copied unchanged.
*/
function toPdfHtml(html, articleIds, stats) {
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
  const token = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g
  const output = []
  const stack = []
  let skipDepth = 0

  for (const match of html.matchAll(token)) {
    const [text, closing, rawTag, attributes] = match

    if (!rawTag) {
      if (!skipDepth) output.push(text)
      continue
    }

    const tag = rawTag.toLowerCase()

    if (closing) {
      const index = stack.findLastIndex((entry) => entry.tag === tag)
      if (index === -1) {
        if (!skipDepth) output.push(text)
        continue
      }
      // Unclosed elements above the match close with it
      const closed = stack.splice(index)
      skipDepth -= closed.filter((entry) => entry.mode === 'complete').length
      if (!skipDepth && closed[0].mode === 'keep') output.push(`</${closed[0].outputTag}>`)
      continue
    }

    const selfClosing = voidTags.has(tag) || /\/\s*$/.test(attributes)
    const mode = skipDepth ? 'inner' : /\sdata-remove-from-pdf="(complete|transient)"/.exec(attributes)?.[1] ?? 'keep'
    const replaceTag = /\sdata-replace-tag="([\w-]+)"/.exec(attributes)?.[1]

    if (mode === 'complete' || mode === 'transient') stats[mode] += 1
    if (mode === 'keep' && replaceTag) stats.replaced += 1
    if (mode === 'keep' && attributes.includes(' data-remove-from-web="')) stats.pdfOnly += 1

    if (!selfClosing) stack.push({ tag, mode, outputTag: replaceTag || rawTag })
    if (mode === 'complete' && !selfClosing) skipDepth += 1
    if (mode !== 'keep') continue

    output.push(rewriteTag(text, rawTag, attributes, replaceTag, articleIds))
  }

  return output.join('')
}

function rewriteTag(text, rawTag, attributes, replaceTag, articleIds) {
  if (!replaceTag && !attributes.includes(' loading="lazy"') && !attributes.includes(' data-article-name="')) {
    return text
  }

  let rewritten = attributes
    .replace(/\sdata-replace-tag="[\w-]+"/, '')
    .replace(' loading="lazy"', '')

  const articleName = /\sdata-article-name="([^"]*)"/.exec(rewritten)?.[1]
  if (articleName !== undefined) {
    const [uuid, anchor] = decodeEntities(articleName).split('#')
    const target = anchor || articleIds.get(uuid)
    rewritten = rewritten.replace(/\sdata-article-name="[^"]*"/, '').replace(/\sdata-note-target="[^"]*"/, '')
    if (target) {
      rewritten = rewritten.replace(/\shref="[^"]*"/, ` href="#${escapeHtml(target)}"`)
    } else {
      console.warn(`Link target ${articleName} is not part of the PDF`)
    }
  }

  return `<${replaceTag || rawTag}${rewritten}>`
}

function decodeEntities(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
}

async function readJson(path) {
  return JSON.parse(await fs.readFile(path, 'utf8'))
}

async function buildSingleFileHtml(fontLink, customerAssets = '') {
  const html = await rewriteImageUrls(await fs.readFile(join(root, options.file), 'utf8'))
  const headAssets = `<base href="/${toUrlPath(options.publicBase)}/">
${fontLink}
<link rel="stylesheet" href="/.output/pdf/pdf.css">
<script src="/.output/pdf/pdf.js" defer></script>${customerAssets ? `\n${customerAssets}` : ''}`
  // Only the head assets are replaced by the project's: style blocks in the body belong to the content (ns.wow
  // exports the column widths of every table as srl-table-tabXXX-colN in %) and the PDF keeps them as well
  const cleanHtml = options.keepFileAssets
    ? html
    : html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, (head) => head
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, ''))

  if (/<head\b[^>]*>/i.test(cleanHtml)) {
    return cleanHtml.replace(/<head\b([^>]*)>/i, `<head$1>\n${headAssets}`)
  }

  return `<!doctype html>
<html lang="${escapeHtml(options.lang)}">
<head>
${headAssets}
<title>Local PDF</title>
</head>
<body>
${cleanHtml}
</body>
</html>`
}

async function rewriteImageUrls(html) {
  const imageDir = join(root, options.publicBase, 'images')
  const imageFiles = new Set(await fs.readdir(imageDir).catch(() => []))

  if (imageFiles.size === 0) {
    return html
  }

  let localized = 0
  let missing = 0
  const rewritten = html.replace(/https:\/\/nswow-ld\.nswow\.ch\/images\/[^"')\s]+/gi, (url) => {
    const filename = decodeURIComponent(url.split('/').pop() || '')

    if (imageFiles.has(filename)) {
      localized += 1
      return `./images/${filename}`
    }

    if (filename === '5e5e15dc-df03-40fc-b3b8-ad07e33d0ce6.svg') {
      localized += 1
      return '/src/assets/images/logo.svg'
    }

    missing += 1
    return url
  })

  console.log(`Image rewrite: ${localized} local, ${missing} still remote`)
  return rewritten
}

async function buildComponentGallery() {
  const templates = await collectComponentTemplates(join(root, 'livingdocs'))
  const templatesByName = Object.fromEntries(
    templates.map((component) => [component.name, component.html])
  )
  const childComponentsByParent = {
    '010.unordered-list': ['040.list-item-unordered-list', '</ul>'],
    '020.ordered-list': ['050.list-item-ordered-list', '</ol>'],
    '030.alphanumeric-list': ['060.list-item-alphanumeric-list', '</ol>'],
    '070.footnote-container': ['080.footnote-item', '</div>'],
    '012.key-figure': ['013.key-figure-container', '</div>']
  }

  const components = templates.map((component) => {
    const child = childComponentsByParent[component.name]

    if (!child) {
      return component
    }

    const [childName, closingTag] = child
    const childHtml = templatesByName[childName]

    if (!childHtml) {
      return component
    }

    return {
      ...component,
      html: component.html.replace(closingTag, `${childHtml}\n${closingTag}`)
    }
  })

  const sections = components.map((component) => {
    return `<section class="srl-local-pdf-component" data-component="${escapeHtml(component.name)}">
  <h1 class="srl-local-pdf-component__label">${escapeHtml(component.label)}</h1>
  <div class="srl-local-pdf-component__preview">${component.html}</div>
</section>`
  })

  return `<article class="srl-article-root srl-local-pdf-components">
${sections.join('\n')}
${keyFigureSample(templatesByName)}
</article>`
}

async function collectComponentTemplates(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const templates = []

  for (const entry of entries) {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) {
      templates.push(...await collectComponentTemplates(path))
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      const folder = path.split(sep).slice(-2, -1)[0] ?? entry.name
      templates.push({
        name: folder,
        label: relative(root, path),
        html: await fs.readFile(path, 'utf8')
      })
    }
  }

  return templates.sort((first, second) => first.label.localeCompare(second.label))
}

function keyFigureSample(templatesByName) {
  const keyFigure = templatesByName['012.key-figure']

  if (!keyFigure) {
    return ''
  }

  return `<section class="srl-local-pdf-component" data-component="012.key-figure-container-sample">
  <h1 class="srl-local-pdf-component__label">Generated sample: key figure container with multiple children</h1>
  <div class="srl-local-pdf-component__preview">
    <div class="ns-key-figure-container">
      <h2 class="ns-title-h2" doc-editable="text">Lorem Ipsum...</h2>
      <div class="content-width" doc-container="container">
        ${keyFigure}
        ${keyFigure}
      </div>
    </div>
  </div>
</section>`
}

function galleryCss() {
  if (options.mode !== 'components') {
    return ''
  }

  return `.srl-local-pdf-component{break-before:page;page-break-before:always;padding-block-start:8mm}
.srl-local-pdf-component:first-child{break-before:auto;page-break-before:auto}
.srl-local-pdf-component__label{font-family:Arial,sans-serif;font-size:8pt;line-height:1.3;font-weight:700;color:#666;border-bottom:0.25pt solid #bbb;margin:0 0 8mm;padding:0 0 2mm}
.srl-local-pdf-component__preview{display:flow-root}`
}

async function serveFile(pathname, response) {
  const decodedPath = decodeURIComponent(pathname)
  const filePath = normalize(join(root, decodedPath))

  if (!isServable(filePath)) {
    console.warn(`Blocked request for ${JSON.stringify(decodedPath)} (only .output, public, src, livingdocs and --public-base are served)`)
    response.writeHead(403)
    response.end('Forbidden')
    return
  }

  const stat = await fs.stat(filePath).catch(() => null)

  if (!stat?.isFile()) {
    response.writeHead(404)
    response.end('Not found')
    return
  }

  response.writeHead(200, { 'content-type': contentType(filePath) })
  createReadStream(filePath).pipe(response)
}

/*
  Only the folders a rendered report loads from are served, so the rest of the project
  (.env, .git, config files) stays private although the server listens on all interfaces.
  Dot segments below these folders are blocked as well.
*/
function isServable(filePath) {
  if (!filePath.startsWith(root + sep)) {
    return false
  }

  const segments = relative(root, filePath).split(sep)
  const allowed = new Set(['.output', 'public', 'src', 'livingdocs', options.publicBase.split(/[\\/]+/).filter(Boolean)[0]])

  return allowed.has(segments[0]) && segments.slice(1).every((segment) => !segment.startsWith('.'))
}

function isLoopback(address = '') {
  return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1'
}

function watchForChanges() {
  const paths = watchPaths().filter((path) => {
    if (existsSync(path)) {
      return true
    }

    console.warn(`Skipping missing watch path: ${relative(root, path)}`)
    return false
  })

  if (paths.length === 0) {
    console.warn('No watch paths exist; the local PDF server will stay up without automatic rebuilds.')
    return
  }

  let timer

  for (const path of paths) {
    watch(path, { recursive: true }, () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        runOnce().catch((error) => {
          console.error(error)
          process.exitCode = 1
        })
      }, 250)
    })
  }

  console.log(`Watching ${paths.map((path) => relative(root, path)).join(', ')} for PDF changes...`)
}

function watchPaths() {
  const customerPaths = options.customer ? [join(root, 'pdf', 'customers', options.customer)] : []
  return [...modeWatchPaths(), ...customerPaths]
}

function modeWatchPaths() {
  if (options.mode === 'file') {
    return [
      join(root, options.file),
      join(root, options.publicBase),
      join(root, 'src'),
      join(root, 'livingdocs')
    ]
  }

  if (options.mode === 'export') {
    return [
      join(root, 'src'),
      join(root, 'livingdocs'),
      join(root, 'public', 'html'),
      join(root, 'public', 'json')
    ]
  }

  if (options.mode === 'components') {
    return [join(root, 'src'), join(root, 'livingdocs')]
  }

  return [
    join(root, 'src'),
    join(root, 'livingdocs'),
    join(root, options.sourceDir),
    join(root, 'public', 'pdf', 'web')
  ]
}

async function closeServer() {
  if (!server) {
    return
  }

  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose())
  })
}

function runCommand(command, args) {
  console.log([command, ...args].join(' '))

  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    })

    child.on('error', rejectCommand)
    child.on('exit', (code) => {
      if (code === 0) {
        resolveCommand()
      } else {
        rejectCommand(new Error(`${command} ${args.join(' ')} exited with ${code}`))
      }
    })
  })
}

function parseArgs(args) {
  const parsed = {
    config: 'pdf/pdf-configuration-debug.xml',
    customer: '',
    documentHost: 'host.docker.internal',
    file: 'public/exclude/generated.html',
    keepFileAssets: false,
    lang: 'de',
    pdfreactorUrl: `http://localhost:${process.env.PDFREACTOR_PORT || 9423}/service/rest/convert.pdf`,
    port: 4175,
    publicBase: 'public/exclude/web',
    mode: '',
    noJs: false,
    output: '',
    skipBuild: false,
    sourceDir: 'public/html',
    watch: false
  }

  let fileGiven = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '--config') parsed.config = args[++index] ?? parsed.config
    else if (arg === '--customer') parsed.customer = args[++index] ?? parsed.customer
    else if (arg === '--file') {
      parsed.file = args[++index] ?? parsed.file
      fileGiven = true
    }
    else if (arg === '--keep-file-assets') parsed.keepFileAssets = true
    else if (arg === '--watch') parsed.watch = true
    else if (arg === '--skip-build') parsed.skipBuild = true
    else if (arg === '--lang') parsed.lang = args[++index] ?? parsed.lang
    else if (arg === '--mode') parsed.mode = args[++index] ?? parsed.mode
    else if (arg === '--no-js') parsed.noJs = true
    else if (arg === '--output') parsed.output = args[++index] ?? parsed.output
    else if (arg === '--port') parsed.port = Number(args[++index] ?? parsed.port)
    else if (arg === '--document-host') parsed.documentHost = args[++index] ?? parsed.documentHost
    else if (arg === '--pdfreactor-url') parsed.pdfreactorUrl = args[++index] ?? parsed.pdfreactorUrl
    else if (arg === '--public-base') parsed.publicBase = args[++index] ?? parsed.publicBase
    else if (arg === '--source-dir') parsed.sourceDir = args[++index] ?? parsed.sourceDir
    else throw new Error(`Unknown argument: ${arg}`)
  }

  if (parsed.customer) {
    parsed.customer = resolveCustomer(parsed.customer)

    // A customer renders its own ns.wow export, stored next to its overlay (gitignored there)
    if (!parsed.mode) {
      parsed.mode = 'file'
    }

    if (parsed.mode === 'file' && !fileGiven) {
      parsed.file = join('pdf', 'customers', parsed.customer, 'pdf.html')

      if (!existsSync(join(root, parsed.file))) {
        throw new Error(`No ns.wow export for ${parsed.customer}: save the PDF HTML from ns.wow as ${parsed.file}, or render all components with the customer styles via --mode components`)
      }
    }
  }

  // Without --mode: the ns.wow document structure when the export has its routing, else plain articles
  if (!parsed.mode) {
    parsed.mode = existsSync(join(root, 'public', 'json', `routing_${parsed.lang}.json`)) ? 'export' : 'content'
  }

  if (!['content', 'export', 'components', 'file'].includes(parsed.mode)) {
    throw new Error(`Unknown mode: ${parsed.mode}`)
  }

  return parsed
}

/*
  The script lives outside the project (~/pdf-reactor), so all paths resolve against the srl
  project it is called from: PDFREACTOR_PROJECT_ROOT, else the nearest package.json above the
  directory npm was started in (INIT_CWD) or the current directory.
*/
function findProjectRoot() {
  if (process.env.PDFREACTOR_PROJECT_ROOT) {
    return resolve(process.env.PDFREACTOR_PROJECT_ROOT)
  }

  const start = resolve(process.env.INIT_CWD || process.cwd())
  let directory = start

  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory)

    if (parent === directory) {
      throw new Error(`No package.json found in ${start} or above, run this inside an srl project`)
    }

    directory = parent
  }

  return directory
}

function detectPackageManager() {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

async function isDirectory(path) {
  const stat = await fs.stat(path).catch(() => null)
  return stat?.isDirectory() ?? false
}

function getOutputFile() {
  if (options.output) {
    return join(root, options.output)
  }

  const filename = options.mode === 'components'
    ? 'components.pdf'
    : options.mode === 'file'
      ? 'generated.pdf'
      : 'report.pdf'

  if (options.customer) {
    return join(outputDir, options.mode === 'file' ? `${options.customer}.pdf` : `${options.customer}-${filename}`)
  }

  return join(outputDir, filename)
}

async function readPdfreactorXmlConfig(configPath) {
  const xml = await fs.readFile(join(root, configPath), 'utf8')
  const config = {}

  readXmlBoolean(xml, 'addTags', (value) => {
    config.addTags = value
  })
  readXmlBoolean(xml, 'appendLog', (value) => {
    config.appendLog = value
  })
  readXmlBoolean(xml, 'debugSettings', (value) => {
    config.debugSettings = { all: value }
  }, 'all')
  readXmlBoolean(xml, 'inspectableSettings', (value) => {
    config.inspectableSettings = { enabled: value }
  }, 'enabled')

  // Repeated elements, one per constant (e.g. PAGE_LAYOUT_TWO_PAGE_RIGHT)
  const viewerPreferences = [...xml.matchAll(/<viewerPreferences>\s*([A-Z_]+)\s*<\/viewerPreferences>/g)].map((match) => match[1])
  if (viewerPreferences.length > 0) {
    config.viewerPreferences = viewerPreferences
  }

  return config
}

function readXmlBoolean(xml, element, assign, childElement = '') {
  const pattern = childElement
    ? new RegExp(`<${element}>[\\s\\S]*?<${childElement}>\\s*(true|false)\\s*<\\/${childElement}>[\\s\\S]*?<\\/${element}>`, 'i')
    : new RegExp(`<${element}>\\s*(true|false)\\s*<\\/${element}>`, 'i')
  const match = xml.match(pattern)

  if (match) {
    assign(match[1].toLowerCase() === 'true')
  }
}

/*
  Customer overlays (pdf/customers/nspXXX-<name>/, e.g. in nsfd_report-standard-customer): the
  folder name or just its nsp prefix. Without that folder the project has no customer builds.
*/
function resolveCustomer(name) {
  const customersDir = join(root, 'pdf', 'customers')
  const folders = existsSync(customersDir)
    ? readdirSync(customersDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : []
  const folder = folders.find((entry) => entry === name) ?? folders.find((entry) => entry.split('-')[0] === name)

  if (!folder) {
    throw new Error(`Unknown customer ${JSON.stringify(name)}, expected a folder in ${relative(root, customersDir)}: ${folders.join(', ') || 'none'}`)
  }

  return folder
}

/*
  The tags ns.wow adds for a customer, in the order of the pdf-configuration.xml that
  'srl build -t pdf --customer' writes to .output/ldd/pdf/<nspXXX>/. The base pdf.css and pdf.js
  are already in the head, everything else (custom.css, custom.js, files from public/) is served
  from .output/ldd/pdf/, so relative URLs in custom.css (fonts, assets) resolve like in ns.wow.
*/
async function customerHeadAssets() {
  if (!options.customer) {
    return ''
  }

  const customerId = options.customer.split('-')[0]
  const configPath = join(root, '.output', 'ldd', 'pdf', customerId, 'pdf-configuration.xml')
  const xml = await fs.readFile(configPath, 'utf8').catch(() => {
    throw new Error(`Could not find ${relative(root, configPath)}, run the build without --skip-build first`)
  })
  const tags = []

  for (const [, type, uri] of xml.matchAll(/<(userStyleSheets|userScripts)>[\s\S]*?<uri>\s*([^<\s]+)\s*<\/uri>[\s\S]*?<\/\1>/g)) {
    const path = uri.match(/\/pdf\/(.+)$/)?.[1]

    if (!path || path === 'pdf.css' || path === 'pdf.js') {
      continue
    }

    const href = `/.output/ldd/pdf/${path}`
    tags.push(type === 'userStyleSheets' ? `<link rel="stylesheet" href="${href}">` : `<script src="${href}" defer></script>`)
  }

  return tags.join('\n')
}

function fontStylesheetLink() {
  const fontCss = join(root, fontStylesheetPath)

  if (!existsSync(fontCss)) {
    console.warn(`Could not find ${relative(root, fontCss)}, run the build first to embed the project fonts`)
    return ''
  }

  return `<link rel="stylesheet" href="${fontStylesheetPath}">`
}

// PDFreactor caches fonts by URL across conversions, including failed downloads.
// Appending the file's mtime makes it fetch the fonts again after every build.
async function serveFontStylesheet(response) {
  const fontDir = join(root, '.output', 'fonts')
  const css = await fs.readFile(join(root, fontStylesheetPath), 'utf8')
  const urls = [...new Set([...css.matchAll(/url\(\s*["']?\.\/([^"')]+)["']?\s*\)/g)].map((match) => match[1]))]
  const versions = new Map(await Promise.all(urls.map(async (file) => {
    const stat = await fs.stat(join(fontDir, file)).catch(() => null)
    return [file, stat ? Math.round(stat.mtimeMs) : Date.now()]
  })))
  const versioned = css.replace(/url\(\s*["']?\.\/([^"')]+)["']?\s*\)/g, (_, file) => `url("./${file}?v=${versions.get(file)}")`)

  response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/css; charset=utf-8' })
  response.end(versioned)
}

function contentType(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case '.css': return 'text/css; charset=utf-8'
    case '.gif': return 'image/gif'
    case '.html': return 'text/html; charset=utf-8'
    case '.jpeg':
    case '.jpg': return 'image/jpeg'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.png': return 'image/png'
    case '.svg': return 'image/svg+xml'
    case '.woff': return 'font/woff'
    case '.woff2': return 'font/woff2'
    default: return 'application/octet-stream'
  }
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function toUrlPath(value) {
  return value.split(/[\\/]+/).filter(Boolean).map(encodeURIComponent).join('/')
}
