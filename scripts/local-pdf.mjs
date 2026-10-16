import { createServer, request as httpRequest } from 'node:http'
import { createReadStream, existsSync, promises as fs } from 'node:fs'
import { watch } from 'node:fs'
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'

const root = findProjectRoot()
const outputDir = join(root, '.output', 'local-pdf')
const fontStylesheetPath = '/.output/fonts/style.css'
// npm_execpath points to the package manager's JS entry (e.g. npm-cli.js), so run it through node
const packageManager = process.env.npm_execpath
  ? { command: process.execPath, args: [process.env.npm_execpath] }
  : { command: detectPackageManager(), args: [] }

const options = parseArgs(process.argv.slice(2))

console.log(`Project ${root}`)

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
      await runCommand(packageManager.command, [...packageManager.args, 'run', 'build-pdf', '--', '--no-clean'])
    }

    await fs.mkdir(outputDir, { recursive: true })

    const port = await ensureServer()
    const documentUrl = `http://${options.documentHost}:${port}/__local-pdf.html?lang=${encodeURIComponent(options.lang)}`
    const localDocumentUrl = `http://127.0.0.1:${port}/__local-pdf.html?lang=${encodeURIComponent(options.lang)}`

    await preflightDocument(localDocumentUrl)

    console.log(`Rendering ${documentUrl}`)
    const pdf = await renderPdf(documentUrl)
    const outputFile = getOutputFile()
    await fs.writeFile(outputFile, pdf)
    console.log(`Wrote ${relative(root, outputFile)}`)
    if (options.watch) {
      console.log(`Latest PDF URL: http://127.0.0.1:${port}/latest.pdf`)
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

  if (!response.ok) {
    const message = responseBody.toString('utf8')
    throw new Error(`PDFreactor failed with ${response.status}: ${message}`)
  }

  const pdf = extractPdfResponse(response, responseBody)

  // Under WSL a freshly opened port takes a moment to become reachable from Docker Desktop
  if (attempt < 5 && responseBody.toString('utf8').includes('HttpHostConnectException')) {
    console.log(`PDFreactor could not reach the local server yet, retrying (${attempt}/5)...`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000))
    return renderPdf(documentUrl, attempt + 1)
  }

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
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(error instanceof Error ? error.stack : String(error))
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
    'content-disposition': `inline; filename="${options.mode === 'file' ? 'generated.pdf' : 'report.pdf'}"`,
    'content-type': 'application/pdf'
  })
  createReadStream(filePath).pipe(response)
}

async function buildHtml(lang) {
  const fontLink = fontStylesheetLink()
  if (options.mode === 'file') {
    return buildSingleFileHtml(fontLink)
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

async function buildSingleFileHtml(fontLink) {
  const html = await rewriteImageUrls(await fs.readFile(join(root, options.file), 'utf8'))
  const headAssets = `<base href="/${toUrlPath(options.publicBase)}/">
${fontLink}
<link rel="stylesheet" href="/.output/pdf/pdf.css">
<script src="/.output/pdf/pdf.js" defer></script>`
  const cleanHtml = options.keepFileAssets
    ? html
    : html
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, '')

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

  if (!filePath.startsWith(root + sep)) {
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
  if (options.mode === 'file') {
    return [
      join(root, options.file),
      join(root, options.publicBase),
      join(root, 'src'),
      join(root, 'livingdocs')
    ]
  }

  return [
    join(root, 'src'),
    join(root, 'livingdocs'),
    join(root, 'public', 'pdf', 'html'),
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
    documentHost: 'host.docker.internal',
    file: 'public/exclude/generated.html',
    keepFileAssets: false,
    lang: 'de',
    pdfreactorUrl: `http://localhost:${process.env.PDFREACTOR_PORT || 9423}/service/rest/convert.pdf`,
    port: 4175,
    publicBase: 'public/exclude/web',
    mode: 'content',
    noJs: false,
    output: '',
    skipBuild: false,
    sourceDir: 'public/html',
    watch: false
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '--config') parsed.config = args[++index] ?? parsed.config
    else if (arg === '--file') parsed.file = args[++index] ?? parsed.file
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
