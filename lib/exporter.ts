import JSZip from 'jszip'
import prisma from '@/lib/db'
import { claudePrompt, getCliAvailability, modelNameToCliAlias } from '@/lib/claude-cli-auth'
import { getAnthropicModel } from '@/lib/settings'
import { resolveAnthropicClient } from '@/lib/claude-cli-auth'

interface BookmarkRow {
  id: string
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  source: string
  tweetCreatedAt: Date | null
  importedAt: Date
  rawJson: string
  entities: string | null
  mediaItems: MediaItemRow[]
  categories: CategoryJoin[]
}

interface MediaItemRow {
  id: string
  type: string
  url: string
  thumbnailUrl: string | null
  localPath: string | null
}

interface CategoryJoin {
  category: {
    name: string
    slug: string
    color: string
  }
}

async function fetchBookmarksFull(where?: object): Promise<BookmarkRow[]> {
  return prisma.bookmark.findMany({
    where,
    include: {
      mediaItems: true,
      categories: {
        include: { category: true },
      },
    },
    orderBy: { importedAt: 'desc' },
  }) as Promise<BookmarkRow[]>
}

function formatCsvField(value: string): string {
  const escaped = value.replace(/"/g, '""')
  return `"${escaped}"`
}

function buildCsvRow(fields: string[]): string {
  return fields.map(formatCsvField).join(',')
}

async function downloadFile(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return null
    const arrayBuffer = await response.arrayBuffer()
    return Buffer.from(arrayBuffer)
  } catch {
    return null
  }
}

function urlToFilename(url: string, index: number, ext: string): string {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/')
    const last = segments[segments.length - 1]
    if (last && last.includes('.')) return last
  } catch {
    // fall through
  }
  return `media_${index}${ext}`
}

function mediaExtension(type: string, url: string): string {
  if (type === 'video') return '.mp4'
  if (type === 'gif') return '.mp4'
  if (url.endsWith('.jpg') || url.endsWith('.jpeg')) return '.jpg'
  if (url.endsWith('.png')) return '.png'
  if (url.endsWith('.webp')) return '.webp'
  return '.jpg'
}

export async function exportCategoryAsZip(categorySlug: string): Promise<Buffer> {
  const category = await prisma.category.findUnique({
    where: { slug: categorySlug },
  })

  if (!category) {
    throw new Error(`Category not found: ${categorySlug}`)
  }

  const bookmarks = await fetchBookmarksFull({
    categories: {
      some: { category: { slug: categorySlug } },
    },
  })

  const zip = new JSZip()
  const mediaFolder = zip.folder('media')

  const manifestRows: string[] = [
    buildCsvRow(['tweetId', 'text', 'author', 'url', 'categories', 'date']),
  ]

  let mediaIndex = 0
  for (const bookmark of bookmarks) {
    const tweetUrl = `https://x.com/i/web/status/${bookmark.tweetId}`
    const categoryNames = bookmark.categories.map((c) => c.category.name).join('; ')
    const dateStr = bookmark.tweetCreatedAt?.toISOString() ?? ''

    manifestRows.push(
      buildCsvRow([
        bookmark.tweetId,
        bookmark.text,
        bookmark.authorHandle,
        tweetUrl,
        categoryNames,
        dateStr,
      ])
    )

    for (const item of bookmark.mediaItems) {
      const ext = mediaExtension(item.type, item.url)
      const filename = urlToFilename(item.url, mediaIndex, ext)
      mediaIndex++

      const fileData = await downloadFile(item.url)
      if (fileData && mediaFolder) {
        mediaFolder.file(filename, fileData)
      }
    }
  }

  zip.file('manifest.csv', manifestRows.join('\n'))

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return buffer
}

export async function exportAllBookmarksCsv(bookmarkIds?: string[]): Promise<string> {
  const where = bookmarkIds && bookmarkIds.length > 0
    ? { id: { in: bookmarkIds } }
    : undefined

  const bookmarks = await fetchBookmarksFull(where)

  const headers = buildCsvRow([
    'tweetId',
    'text',
    'authorHandle',
    'source',
    'categories',
    'tweetCreatedAt',
    'mediaUrls',
  ])

  const rows = bookmarks.map((bookmark) => {
    const categories = bookmark.categories.map((c) => c.category.name).join('; ')
    const mediaUrls = bookmark.mediaItems.map((m) => m.url).join('; ')
    const dateStr = bookmark.tweetCreatedAt?.toISOString() ?? ''

    return buildCsvRow([
      bookmark.tweetId,
      bookmark.text,
      bookmark.authorHandle,
      bookmark.source,
      categories,
      dateStr,
      mediaUrls,
    ])
  })

  return [headers, ...rows].join('\n')
}

export async function exportBookmarksJson(bookmarkIds?: string[]): Promise<string> {
  const where = bookmarkIds && bookmarkIds.length > 0
    ? { id: { in: bookmarkIds } }
    : undefined

  const bookmarks = await fetchBookmarksFull(where)

  const output = bookmarks.map((bookmark) => ({
    tweetId: bookmark.tweetId,
    text: bookmark.text,
    authorHandle: bookmark.authorHandle,
    authorName: bookmark.authorName,
    source: bookmark.source,
    tweetCreatedAt: bookmark.tweetCreatedAt?.toISOString() ?? null,
    importedAt: bookmark.importedAt.toISOString(),
    categories: bookmark.categories.map((c) => ({
      name: c.category.name,
      slug: c.category.slug,
      color: c.category.color,
    })),
    mediaItems: bookmark.mediaItems.map((m) => ({
      type: m.type,
      url: m.url,
      thumbnailUrl: m.thumbnailUrl,
    })),
  }))

  return JSON.stringify(output, null, 2)
}

// ---------------------------------------------------------------------------
// Markdown Export (AI-optimized)
// ---------------------------------------------------------------------------

export async function exportBookmarksMarkdown(bookmarkIds?: string[]): Promise<string> {
  const where = bookmarkIds && bookmarkIds.length > 0
    ? { id: { in: bookmarkIds } }
    : undefined

  const bookmarks = await fetchBookmarksFull(where)

  // Build category summary counts
  const categoryCounts = new Map<string, number>()
  for (const b of bookmarks) {
    for (const c of b.categories) {
      categoryCounts.set(c.category.name, (categoryCounts.get(c.category.name) ?? 0) + 1)
    }
  }
  const uncategorizedCount = bookmarks.filter((b) => b.categories.length === 0).length

  const lines: string[] = []

  // Header
  lines.push('# Siftly Bookmark Export')
  lines.push('')
  lines.push(`**Total bookmarks:** ${bookmarks.length}`)
  lines.push(`**Export date:** ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`)
  lines.push('')

  // Category summary
  if (categoryCounts.size > 0) {
    lines.push('## Categories')
    lines.push('')
    const sorted = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])
    for (const [name, count] of sorted) {
      lines.push(`- ${name} (${count})`)
    }
    if (uncategorizedCount > 0) {
      lines.push(`- Uncategorized (${uncategorizedCount})`)
    }
    lines.push('')
  }

  lines.push('---')
  lines.push('')

  // Each bookmark
  for (let i = 0; i < bookmarks.length; i++) {
    const b = bookmarks[i]
    const dateStr = b.tweetCreatedAt
      ? b.tweetCreatedAt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : ''
    const author = b.authorHandle !== 'unknown' ? `@${b.authorHandle}` : 'Unknown author'
    const heading = dateStr ? `${author} — ${dateStr}` : author

    lines.push(`### ${i + 1}. ${heading}`)
    lines.push('')

    // Tweet text — expand t.co URLs for readability
    const expandedText = expandTweetUrls(b.text, b.rawJson)
    // Strip remaining t.co links
    const cleanText = expandedText.replace(/https?:\/\/t\.co\/[^\s]+/g, '').trim()
    if (cleanText) {
      lines.push(cleanText)
      lines.push('')
    }

    // Categories
    if (b.categories.length > 0) {
      const cats = b.categories.map((c) => c.category.name).join(', ')
      lines.push(`**Categories:** ${cats}`)
    }

    // Tweet URL
    lines.push(`**Tweet:** https://x.com/i/web/status/${b.tweetId}`)

    // Entities — links, mentions, tools
    const ent = parseBookmarkEntities(b.entities, b.rawJson)
    if (ent.urls.length > 0) {
      lines.push(`**Links:** ${ent.urls.join(', ')}`)
    }
    if (ent.mentions.length > 0) {
      lines.push(`**Mentions:** ${ent.mentions.map((m) => `@${m}`).join(', ')}`)
    }
    if (ent.tools.length > 0) {
      lines.push(`**Tools:** ${ent.tools.join(', ')}`)
    }

    // Media
    if (b.mediaItems.length > 0) {
      const mediaDescriptions = b.mediaItems.map((m) => `[${m.type}](${m.url})`).join(', ')
      lines.push(`**Media:** ${mediaDescriptions}`)
    }

    lines.push('')
    lines.push('---')
    lines.push('')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// HTML Export
// ---------------------------------------------------------------------------

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

interface ParsedEntities {
  hashtags: string[]
  urls: string[]
  mentions: string[]
  tools: string[]
}

/** Replace t.co short URLs in tweet text with their expanded URLs from entities data. */
function expandTweetUrls(text: string, rawJson: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tweet = JSON.parse(rawJson) as any
    const urlEntities: { url?: string; expanded_url?: string }[] =
      tweet?.entities?.urls ?? tweet?.legacy?.entities?.urls ?? []
    for (const entity of urlEntities) {
      if (entity.url && entity.expanded_url) {
        text = text.replaceAll(entity.url, entity.expanded_url)
      }
    }
  } catch { /* ignore parse errors */ }
  return text
}

/** Convert @mentions and URLs in text to clickable HTML links. */
function linkifyTweetText(text: string): string {
  const segments: { type: 'text' | 'mention' | 'url'; value: string }[] = []
  const pattern = /(@[A-Za-z0-9_]+)|(https?:\/\/[^\s)\]>]+)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) })
    }
    if (match[1]) {
      segments.push({ type: 'mention', value: match[1] })
    } else if (match[2]) {
      segments.push({ type: 'url', value: match[2] })
    }
    lastIndex = pattern.lastIndex
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) })
  }

  return segments.map((seg) => {
    if (seg.type === 'mention') {
      const handle = seg.value.slice(1)
      return `<a href="https://x.com/${escapeHtml(handle)}" target="_blank" rel="noopener noreferrer">${escapeHtml(seg.value)}</a>`
    }
    if (seg.type === 'url') {
      const displayUrl = seg.value.replace(/^https?:\/\//, '').replace(/\/$/, '')
      return `<a href="${escapeHtml(seg.value)}" target="_blank" rel="noopener noreferrer">${escapeHtml(displayUrl)}</a>`
    }
    return escapeHtml(seg.value)
  }).join('')
}

/** Extract entity data from stored entities JSON or rawJson fallback. */
function parseBookmarkEntities(entities: string | null, rawJson: string): ParsedEntities {
  const empty: ParsedEntities = { hashtags: [], urls: [], mentions: [], tools: [] }

  if (entities) {
    try {
      const parsed = JSON.parse(entities)
      return {
        hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
        urls: Array.isArray(parsed.urls) ? parsed.urls : [],
        mentions: Array.isArray(parsed.mentions) ? parsed.mentions : [],
        tools: Array.isArray(parsed.tools) ? parsed.tools : [],
      }
    } catch { /* fall through */ }
  }

  // Fallback: extract from rawJson inline (mirrors rawjson-extractor logic)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tweet = JSON.parse(rawJson) as any
    const urlObjs: { expanded_url?: string; url?: string }[] =
      tweet?.entities?.urls ?? tweet?.legacy?.entities?.urls ?? []
    const urls = urlObjs
      .map((u: { expanded_url?: string; url?: string }) => String(u.expanded_url ?? u.url ?? ''))
      .filter((u: string) => u && !u.includes('twitter.com') && !u.includes('t.co/') && !u.includes('x.com/'))
    const mentionObjs: { screen_name?: string; username?: string }[] =
      tweet?.entities?.user_mentions ?? tweet?.legacy?.entities?.user_mentions ?? []
    const mentions = mentionObjs
      .map((m: { screen_name?: string; username?: string }) => String(m.screen_name ?? m.username ?? '').toLowerCase())
      .filter(Boolean)
    return { hashtags: [], urls, mentions, tools: [] }
  } catch { /* ignore */ }

  return empty
}

/** Build HTML for the entities section (mentions, URLs, tools) below the tweet text. */
function buildEntitiesHtml(ent: ParsedEntities): string {
  const sections: string[] = []

  if (ent.mentions.length > 0) {
    const items = ent.mentions.map((h) => {
      const safe = escapeHtml(h)
      return `<a class="card-entities__item" href="https://x.com/${safe}" target="_blank" rel="noopener noreferrer">@${safe}</a>`
    }).join('')
    sections.push(`
      <div class="card-entities__section">
        <span class="card-entities__label">Mentions</span>
        <div class="card-entities__list">${items}</div>
      </div>`)
  }

  if (ent.urls.length > 0) {
    const items = ent.urls.map((url) => {
      const safeUrl = escapeHtml(url)
      let displayUrl: string
      try {
        const parsed = new URL(url)
        displayUrl = escapeHtml(parsed.hostname.replace(/^www\./, '') + (parsed.pathname !== '/' ? parsed.pathname : ''))
      } catch {
        displayUrl = safeUrl.slice(0, 40)
      }
      return `<a class="card-entities__item card-entities__item--url" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${displayUrl}</a>`
    }).join('')
    sections.push(`
      <div class="card-entities__section">
        <span class="card-entities__label">Links</span>
        <div class="card-entities__list">${items}</div>
      </div>`)
  }

  if (ent.tools.length > 0) {
    const items = ent.tools.map((t) =>
      `<span class="card-entities__item card-entities__item--tool">${escapeHtml(t)}</span>`
    ).join('')
    sections.push(`
      <div class="card-entities__section">
        <span class="card-entities__label">Tools &amp; Products</span>
        <div class="card-entities__list">${items}</div>
      </div>`)
  }

  if (sections.length === 0) return ''
  return `<div class="card-entities">${sections.join('')}</div>`
}

function formatExportDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function formatTweetDate(date: Date | null): string {
  if (!date) return ''
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function buildHtmlStyles(): string {
  return `
    /* Reset & base */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html { scroll-behavior: smooth; }

    body {
      background-color: #0A0B0D;
      color: #E4E4E7;
      font-family: 'Space Grotesk', system-ui, sans-serif;
      font-size: 16px;
      line-height: 1.6;
      min-height: 100vh;
    }

    a { color: #A855F7; text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* Layout */
    .container {
      max-width: 1280px;
      margin: 0 auto;
      padding: 0 1.25rem;
    }

    /* Hero */
    .hero {
      padding: 4rem 1.25rem 3rem;
      text-align: center;
      border-bottom: 1px solid #1E2028;
      background: linear-gradient(180deg, #0F1016 0%, #0A0B0D 100%);
    }

    .hero__brand {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #A855F7;
      margin-bottom: 1.5rem;
    }

    .hero__brand-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #A855F7;
      display: inline-block;
    }

    .hero__title {
      font-size: clamp(2rem, 5vw, 3.5rem);
      font-weight: 700;
      letter-spacing: -0.02em;
      line-height: 1.15;
      margin-bottom: 1.25rem;
      background: linear-gradient(135deg, #E4E4E7 30%, #A855F7 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .hero__meta {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 1.25rem;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      color: #71717A;
    }

    .hero__meta-item {
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    .hero__meta-value {
      color: #E4E4E7;
      font-weight: 600;
    }

    /* Main content */
    .main {
      padding: 3rem 1.25rem 5rem;
      max-width: 1280px;
      margin: 0 auto;
    }

    /* Category section */
    .category-section {
      margin-bottom: 3.5rem;
    }

    .category-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1.5rem;
      padding-bottom: 0.875rem;
      border-bottom: 1px solid #1E2028;
    }

    .category-color-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .category-name {
      font-size: 1.25rem;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: #E4E4E7;
    }

    .category-count {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      color: #71717A;
      background: #131417;
      border: 1px solid #1E2028;
      border-radius: 8px;
      padding: 0.2rem 0.55rem;
      margin-left: auto;
    }

    .category-section__inner {
      border-left: 3px solid var(--cat-color, #A855F7);
      padding-left: 1.5rem;
    }

    /* Bookmark grid */
    .bookmark-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 1rem;
    }

    /* Bookmark card */
    .bookmark-card {
      background: #131417;
      border: 1px solid #1E2028;
      border-radius: 16px;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.875rem;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      animation: fadeSlideUp 0.4s ease both;
    }

    .bookmark-card:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45), 0 0 0 1px #A855F720;
    }

    /* Card author */
    .card-author {
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }

    .card-author__avatar {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: linear-gradient(135deg, #A855F7, #F5A623);
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 0.875rem;
      color: #fff;
    }

    .card-author__info {
      display: flex;
      flex-direction: column;
      gap: 0.1rem;
      min-width: 0;
    }

    .card-author__name {
      font-weight: 600;
      font-size: 0.9rem;
      color: #E4E4E7;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .card-author__handle {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      color: #71717A;
    }

    .card-author__handle a { color: #71717A; }
    .card-author__handle a:hover { color: #A855F7; text-decoration: none; }

    /* Card text */
    .card-text {
      font-size: 0.9rem;
      line-height: 1.65;
      color: #D4D4D8;
      word-break: break-word;
      white-space: pre-wrap;
    }

    .card-text a { color: #A855F7; text-decoration: none; }
    .card-text a:hover { text-decoration: underline; }

    /* Entities section */
    .card-entities {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .card-entities__section {
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
    }

    .card-entities__label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.65rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #71717A;
    }

    .card-entities__list {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
    }

    .card-entities__item {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.72rem;
      color: #A855F7;
      background: rgba(168, 85, 247, 0.06);
      border: 1px solid rgba(168, 85, 247, 0.12);
      border-radius: 6px;
      padding: 0.15rem 0.45rem;
      text-decoration: none;
      white-space: nowrap;
    }

    .card-entities__item:hover { background: rgba(168, 85, 247, 0.12); text-decoration: none; }

    .card-entities__item--url {
      color: #06B6D4;
      background: rgba(6, 182, 212, 0.06);
      border-color: rgba(6, 182, 212, 0.12);
      white-space: normal;
      word-break: break-all;
    }

    .card-entities__item--url:hover { background: rgba(6, 182, 212, 0.12); }

    .card-entities__item--tool {
      color: #F5A623;
      background: rgba(245, 166, 35, 0.06);
      border-color: rgba(245, 166, 35, 0.12);
    }

    /* Card thumbnail */
    .card-thumbnail {
      border-radius: 8px;
      overflow: hidden;
      aspect-ratio: 16 / 9;
      background: #0A0B0D;
    }

    .card-thumbnail img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    /* Card category pills */
    .card-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
    }

    .card-pill {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.7rem;
      letter-spacing: 0.04em;
      border-radius: 8px;
      padding: 0.2rem 0.55rem;
      border: 1px solid transparent;
      white-space: nowrap;
    }

    /* Card footer */
    .card-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      margin-top: auto;
      padding-top: 0.5rem;
      border-top: 1px solid #1E2028;
    }

    .card-date {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.7rem;
      color: #52525B;
    }

    .card-view-link {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.72rem;
      color: #A855F7;
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      flex-shrink: 0;
    }

    .card-view-link:hover { color: #F5A623; text-decoration: none; }

    /* Footer */
    .site-footer {
      text-align: center;
      padding: 2.5rem 1.25rem;
      border-top: 1px solid #1E2028;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      color: #3F3F46;
    }

    .site-footer a { color: #52525B; }
    .site-footer a:hover { color: #A855F7; text-decoration: none; }

    /* Staggered animation */
    @keyframes fadeSlideUp {
      from {
        opacity: 0;
        transform: translateY(16px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    /* Responsive tweaks */
    @media (max-width: 480px) {
      .hero { padding: 2.5rem 1rem 2rem; }
      .main { padding: 2rem 1rem 4rem; }
      .bookmark-grid { grid-template-columns: 1fr; }
      .category-section__inner { padding-left: 1rem; }
    }
  `
}

function buildBookmarkCardHtml(bookmark: BookmarkRow, animationDelay: number): string {
  const tweetUrl = `https://x.com/${bookmark.authorHandle}/status/${bookmark.tweetId}`
  const profileUrl = `https://x.com/${bookmark.authorHandle}`
  const authorInitial = escapeHtml(
    (bookmark.authorName || bookmark.authorHandle).charAt(0).toUpperCase()
  )
  const authorName = escapeHtml(bookmark.authorName || bookmark.authorHandle)
  const handle = escapeHtml(bookmark.authorHandle)
  // Expand t.co URLs to real URLs, then linkify @mentions and URLs
  const expandedText = expandTweetUrls(bookmark.text, bookmark.rawJson)
  const tweetText = linkifyTweetText(expandedText)
  const dateStr = formatTweetDate(bookmark.tweetCreatedAt)

  // Parse entities for structured display
  const ent = parseBookmarkEntities(bookmark.entities, bookmark.rawJson)
  const entitiesHtml = buildEntitiesHtml(ent)

  // First media item that has a usable URL
  const firstMedia = bookmark.mediaItems.find((m) => m.url)
  const thumbnailHtml = firstMedia
    ? `
      <div class="card-thumbnail">
        <img src="${escapeHtml(firstMedia.thumbnailUrl ?? firstMedia.url)}"
             alt="Media from @${handle}"
             loading="lazy"
             onerror="this.parentElement.style.display='none'" />
      </div>`
    : ''

  // Category pills
  const pillsHtml = bookmark.categories.length > 0
    ? `
      <div class="card-pills">
        ${bookmark.categories.map(({ category }) => {
          const color = escapeHtml(category.color)
          const name = escapeHtml(category.name)
          return `<span class="card-pill"
                        style="color:${color};border-color:${color}22;background:${color}11"
                  >${name}</span>`
        }).join('')}
      </div>`
    : ''

  const dateHtml = dateStr
    ? `<span class="card-date">${escapeHtml(dateStr)}</span>`
    : '<span></span>'

  return `
    <article class="bookmark-card" style="animation-delay:${animationDelay}ms">
      <div class="card-author">
        <div class="card-author__avatar" aria-hidden="true">${authorInitial}</div>
        <div class="card-author__info">
          <span class="card-author__name">${authorName}</span>
          <span class="card-author__handle">
            <a href="${escapeHtml(profileUrl)}" target="_blank" rel="noopener noreferrer">@${handle}</a>
          </span>
        </div>
      </div>
      <p class="card-text">${tweetText}</p>
      ${entitiesHtml}
      ${thumbnailHtml}
      ${pillsHtml}
      <div class="card-footer">
        ${dateHtml}
        <a class="card-view-link"
           href="${escapeHtml(tweetUrl)}"
           target="_blank"
           rel="noopener noreferrer"
           aria-label="View tweet by @${handle} on X">
          View on X &#8599;
        </a>
      </div>
    </article>`
}

function buildCategorySectionHtml(
  name: string,
  color: string,
  bookmarks: BookmarkRow[],
  globalCardOffset: number,
  slug?: string
): string {
  const safeColor = escapeHtml(color)
  const safeName = escapeHtml(name)
  const sectionId = escapeHtml(slug ?? name.toLowerCase().replace(/\s+/g, '-'))

  const cardsHtml = bookmarks
    .map((b, i) =>
      buildBookmarkCardHtml(b, Math.min((globalCardOffset + i) * 60, 3000))
    )
    .join('')

  return `
    <section class="category-section" id="cat-${sectionId}" aria-labelledby="cat-label-${sectionId}">
      <div class="category-header">
        <span class="category-color-dot" style="background:${safeColor}" aria-hidden="true"></span>
        <h2 class="category-name" id="cat-label-${sectionId}">
          ${safeName}
        </h2>
        <span class="category-count">${bookmarks.length}</span>
      </div>
      <div class="category-section__inner" style="--cat-color:${safeColor}">
        <div class="bookmark-grid" role="list">
          ${cardsHtml}
        </div>
      </div>
    </section>`
}

// ---------------------------------------------------------------------------
// Enhanced HTML Export: Sidebar, Mindmap, Search, Navigation
// ---------------------------------------------------------------------------

function buildNavigationStyles(): string {
  return `
    /* ── Sidebar + layout ── */
    .layout { display: flex; max-width: 1440px; margin: 0 auto; }

    .sidebar {
      width: 250px; flex-shrink: 0;
      padding: 1.25rem 0.75rem;
      position: sticky; top: 0; height: 100vh;
      overflow-y: auto; scrollbar-width: thin;
      border-right: 1px solid #1E2028;
      background: #0C0D10;
    }

    .sidebar__title {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.65rem; letter-spacing: 0.1em;
      text-transform: uppercase; color: #52525B;
      padding: 0 0.5rem; margin-bottom: 0.75rem;
    }

    .sidebar__list { display: flex; flex-direction: column; gap: 2px; }

    .sidebar__divider { height: 1px; background: #1E2028; margin: 0.5rem 0; }

    .sidebar__item {
      display: flex; align-items: center; gap: 0.5rem;
      padding: 0.45rem 0.65rem; border-radius: 8px;
      font-size: 0.8rem; color: #A1A1AA;
      text-decoration: none; transition: all 0.15s;
    }
    .sidebar__item:hover { background: #18191E; color: #E4E4E7; text-decoration: none; }
    .sidebar__item.active { background: #1E1F26; color: #E4E4E7; font-weight: 600; }

    .sidebar__dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .sidebar__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sidebar__count { font-family: 'JetBrains Mono', monospace; font-size: 0.65rem; color: #52525B; }

    .content-area { flex: 1; min-width: 0; }

    /* ── Mindmap ── */
    .mindmap-section {
      padding: 2.5rem 1.25rem 2rem;
      border-bottom: 1px solid #1E2028;
      background: linear-gradient(180deg, #0C0D10 0%, #0A0B0D 100%);
      text-align: center;
    }

    .mindmap-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.65rem; letter-spacing: 0.1em;
      text-transform: uppercase; color: #52525B;
      margin-bottom: 1.25rem;
    }

    .mindmap-svg { max-width: 900px; width: 100%; margin: 0 auto; display: block; }
    .mindmap-svg text { font-family: 'Space Grotesk', system-ui, sans-serif; pointer-events: none; }
    .mindmap-node { transition: opacity 0.2s; }
    .mindmap-node:hover { opacity: 0.8; }
    .mindmap-node:hover circle { stroke-width: 2.5; }

    /* ── Search ── */
    .search-bar {
      padding: 0.75rem 1.25rem;
      position: sticky; top: 0; z-index: 10;
      background: rgba(10, 11, 13, 0.92);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid #1E2028;
    }

    .search-wrapper { position: relative; max-width: 360px; }

    .search-input {
      width: 100%;
      padding: 0.55rem 0.75rem 0.55rem 2.25rem;
      border-radius: 10px; border: 1px solid #27272A;
      background: #131417; color: #E4E4E7;
      font-size: 0.82rem; font-family: 'Space Grotesk', system-ui, sans-serif;
      outline: none; transition: border-color 0.2s;
    }
    .search-input:focus { border-color: #A855F7; }
    .search-input::placeholder { color: #52525B; }

    .search-icon {
      position: absolute; left: 0.65rem; top: 50%;
      transform: translateY(-50%); color: #52525B;
      pointer-events: none; line-height: 0;
    }

    .search-count {
      position: absolute; right: 0.75rem; top: 50%;
      transform: translateY(-50%);
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.7rem; color: #52525B;
    }

    /* ── Back to top ── */
    .back-to-top {
      position: fixed; bottom: 1.5rem; right: 1.5rem;
      width: 38px; height: 38px; border-radius: 10px;
      background: #A855F7; color: #fff; border: none;
      cursor: pointer; display: flex; align-items: center;
      justify-content: center; font-size: 1.1rem;
      opacity: 0; transform: translateY(8px);
      transition: all 0.25s; z-index: 50;
      box-shadow: 0 4px 16px rgba(168, 85, 247, 0.3);
    }
    .back-to-top.visible { opacity: 1; transform: translateY(0); }
    .back-to-top:hover { background: #9333EA; }

    /* ── Mobile ── */
    @media (max-width: 768px) {
      .sidebar { display: none; }
      .layout { flex-direction: column; }
      .mindmap-section { padding: 1.5rem 1rem; }
    }
  `
}

function buildMindmapSvg(
  categories: { name: string; slug: string; color: string; count: number }[],
  totalBookmarks: number,
  title: string
): string {
  if (categories.length === 0) return ''

  const count = categories.length
  const nodeR = count > 14 ? 26 : count > 8 ? 30 : 36
  const centerR = 44

  const minRadius = centerR + nodeR + 50
  const circumNeeded = count * (nodeR * 2 + 24)
  const radius = Math.max(minRadius, Math.round(circumNeeded / (2 * Math.PI)))

  const pad = nodeR + 15
  const cx = radius + pad
  const cy = radius + pad
  const viewW = (radius + pad) * 2
  const viewH = (radius + pad) * 2

  const lines: string[] = []
  const nodes: string[] = []

  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2
    const x = Math.round(cx + radius * Math.cos(angle))
    const y = Math.round(cy + radius * Math.sin(angle))
    const color = escapeHtml(categories[i].color)
    lines.push(
      `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="${color}" stroke-width="1.5" opacity="0.2" />`
    )
  }

  for (let i = 0; i < count; i++) {
    const cat = categories[i]
    const angle = (2 * Math.PI * i) / count - Math.PI / 2
    const x = Math.round(cx + radius * Math.cos(angle))
    const y = Math.round(cy + radius * Math.sin(angle))
    const color = escapeHtml(cat.color)
    const slug = escapeHtml(cat.slug)
    const maxLen = count > 14 ? 9 : count > 8 ? 12 : 15
    const name = escapeHtml(cat.name.length > maxLen ? cat.name.slice(0, maxLen - 1) + '\u2026' : cat.name)
    const fontSize = count > 14 ? 8.5 : count > 8 ? 9.5 : 10.5

    nodes.push(
      `<g class="mindmap-node" onclick="document.getElementById('cat-${slug}').scrollIntoView({behavior:'smooth',block:'start'})" style="cursor:pointer">
    <circle cx="${x}" cy="${y}" r="${nodeR}" fill="${color}" fill-opacity="0.08" stroke="${color}" stroke-width="1.5" />
    <text x="${x}" y="${y - 3}" text-anchor="middle" fill="${color}" font-size="${fontSize}" font-weight="600">${name}</text>
    <text x="${x}" y="${y + 10}" text-anchor="middle" fill="#71717A" font-size="8.5" font-family="JetBrains Mono, monospace">${cat.count}</text>
  </g>`
    )
  }

  const centerTitle = escapeHtml(title.length > 18 ? title.slice(0, 16) + '\u2026' : title)
  const centerNode =
    `<circle cx="${cx}" cy="${cy}" r="${centerR}" fill="#A855F7" fill-opacity="0.06" stroke="#A855F7" stroke-width="2" />
  <text x="${cx}" y="${cy - 5}" text-anchor="middle" fill="#E4E4E7" font-size="11" font-weight="700">${centerTitle}</text>
  <text x="${cx}" y="${cy + 9}" text-anchor="middle" fill="#A855F7" font-size="9.5" font-family="JetBrains Mono, monospace">${totalBookmarks} bookmarks</text>`

  return `<svg class="mindmap-svg" viewBox="0 0 ${viewW} ${viewH}" xmlns="http://www.w3.org/2000/svg">
${lines.join('\n')}
${centerNode}
${nodes.join('\n')}
</svg>`
}

function buildSidebarHtml(
  categories: { name: string; slug: string; color: string; count: number }[],
  uncategorizedCount: number
): string {
  const items = categories.map(cat => {
    const s = escapeHtml(cat.slug)
    return `<a href="#cat-${s}" class="sidebar__item" data-section="cat-${s}">
          <span class="sidebar__dot" style="background:${escapeHtml(cat.color)}"></span>
          <span class="sidebar__name">${escapeHtml(cat.name)}</span>
          <span class="sidebar__count">${cat.count}</span>
        </a>`
  }).join('\n        ')

  const uncatItem = uncategorizedCount > 0
    ? `<a href="#cat-uncategorized" class="sidebar__item" data-section="cat-uncategorized">
          <span class="sidebar__dot" style="background:#71717A"></span>
          <span class="sidebar__name">Uncategorized</span>
          <span class="sidebar__count">${uncategorizedCount}</span>
        </a>`
    : ''

  return `
    <nav class="sidebar" aria-label="Category navigation">
      <div class="sidebar__title">Navigate</div>
      <div class="sidebar__list">
        <a href="#mindmap" class="sidebar__item" data-section="mindmap">
          <span class="sidebar__dot" style="background:#A855F7"></span>
          <span class="sidebar__name">Mindmap</span>
        </a>
        <div class="sidebar__divider"></div>
        ${items}
        ${uncatItem}
      </div>
    </nav>`
}

function buildExportScript(): string {
  return `<script>
(function(){
  // ── Search ──
  var si = document.getElementById('export-search');
  var sc = document.getElementById('search-count');
  if (si) {
    var dt;
    si.addEventListener('input', function(){
      clearTimeout(dt);
      dt = setTimeout(function(){
        var q = si.value.toLowerCase().trim();
        var cards = document.querySelectorAll('.bookmark-card');
        var shown = 0;
        cards.forEach(function(c){
          var vis = !q || c.textContent.toLowerCase().indexOf(q) !== -1;
          c.style.display = vis ? '' : 'none';
          if (vis) shown++;
        });
        document.querySelectorAll('.category-section').forEach(function(s){
          var vc = s.querySelectorAll('.bookmark-card:not([style*="display: none"])');
          s.style.display = (vc.length > 0 || !q) ? '' : 'none';
        });
        if (sc) sc.textContent = q ? shown + ' found' : '';
      }, 200);
    });
  }

  // ── Back to top ──
  var btn = document.getElementById('back-to-top');
  if (btn) {
    window.addEventListener('scroll', function(){
      btn.classList.toggle('visible', window.scrollY > 400);
    });
    btn.addEventListener('click', function(){
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // ── Active sidebar on scroll ──
  var items = document.querySelectorAll('.sidebar__item[data-section]');
  var sects = document.querySelectorAll('.category-section[id], #mindmap');
  if (items.length && sects.length && window.IntersectionObserver) {
    var obs = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if (e.isIntersecting) {
          items.forEach(function(it){
            it.classList.toggle('active', it.getAttribute('data-section') === e.target.id);
          });
        }
      });
    }, { rootMargin: '-15% 0px -75% 0px' });
    sects.forEach(function(s){ obs.observe(s); });
  }
})();
</script>`
}

export async function exportBookmarksHtml(
  bookmarkIds?: string[],
  title?: string
): Promise<string> {
  const where =
    bookmarkIds && bookmarkIds.length > 0
      ? { id: { in: bookmarkIds } }
      : undefined

  const bookmarks = await fetchBookmarksFull(where)

  const exportTitle = title || 'My Curated Bookmarks'
  const exportDate = new Date()

  // Group bookmarks by category. Bookmarks with multiple categories appear
  // under each category. Bookmarks with no categories go to "Uncategorized".
  const categoryMap = new Map<string, { name: string; slug: string; color: string; bookmarks: BookmarkRow[] }>()

  for (const bookmark of bookmarks) {
    if (bookmark.categories.length === 0) {
      continue // handled below
    }
    for (const { category } of bookmark.categories) {
      if (!categoryMap.has(category.slug)) {
        categoryMap.set(category.slug, {
          name: category.name,
          slug: category.slug,
          color: category.color,
          bookmarks: [],
        })
      }
      categoryMap.get(category.slug)!.bookmarks.push(bookmark)
    }
  }

  const uncategorized = bookmarks.filter((b) => b.categories.length === 0)

  // Build section HTML for each category, tracking card count for stagger offset
  let cardOffset = 0
  const sectionsHtml: string[] = []

  for (const entry of categoryMap.values()) {
    sectionsHtml.push(
      buildCategorySectionHtml(entry.name, entry.color, entry.bookmarks, cardOffset, entry.slug)
    )
    cardOffset += entry.bookmarks.length
  }

  if (uncategorized.length > 0) {
    sectionsHtml.push(
      buildCategorySectionHtml('Uncategorized', '#71717A', uncategorized, cardOffset, 'uncategorized')
    )
  }

  // Navigation data
  const categoryList = Array.from(categoryMap.values()).map(c => ({
    name: c.name,
    slug: c.slug,
    color: c.color,
    count: c.bookmarks.length,
  }))
  const categoryCount = categoryMap.size + (uncategorized.length > 0 ? 1 : 0)

  const mindmapSvg = buildMindmapSvg(categoryList, bookmarks.length, exportTitle)
  const sidebarHtml = buildSidebarHtml(categoryList, uncategorized.length)

  const safeTitle = escapeHtml(exportTitle)
  const safeDateLong = escapeHtml(formatExportDate(exportDate))
  const safeDateIso = exportDate.toISOString()

  const searchIconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>'

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <style>${buildHtmlStyles()}</style>
  <style>${buildNavigationStyles()}</style>
</head>
<body>
  <header class="hero" role="banner">
    <div class="hero__brand">
      <span class="hero__brand-dot" aria-hidden="true"></span>
      Exported from Siftly
    </div>
    <h1 class="hero__title">${safeTitle}</h1>
    <div class="hero__meta" role="list">
      <div class="hero__meta-item" role="listitem">
        <span>Bookmarks</span>
        <span class="hero__meta-value">${bookmarks.length}</span>
      </div>
      <div class="hero__meta-item" role="listitem">
        <span>Categories</span>
        <span class="hero__meta-value">${categoryCount}</span>
      </div>
      <div class="hero__meta-item" role="listitem">
        <span>Exported</span>
        <time class="hero__meta-value" datetime="${safeDateIso}">${safeDateLong}</time>
      </div>
    </div>
  </header>

  ${mindmapSvg ? `<section class="mindmap-section" id="mindmap">
    <div class="mindmap-label">Bookmark Mindmap &mdash; click a category to jump</div>
    ${mindmapSvg}
  </section>` : ''}

  <div class="layout">
    ${sidebarHtml}
    <div class="content-area">
      <div class="search-bar">
        <div class="search-wrapper">
          <span class="search-icon">${searchIconSvg}</span>
          <input type="text" id="export-search" class="search-input"
                 placeholder="Search ${bookmarks.length.toLocaleString()} bookmarks\u2026" autocomplete="off" />
          <span class="search-count" id="search-count"></span>
        </div>
      </div>
      <main class="main" id="main-content">
        ${sectionsHtml.join('\n')}
      </main>
    </div>
  </div>

  <footer class="site-footer" role="contentinfo">
    Exported from <a href="https://github.com/viperrcrypto/siftly" target="_blank" rel="noopener noreferrer">Siftly</a>
    &nbsp;&mdash;&nbsp;
    <time datetime="${safeDateIso}">${safeDateLong}</time>
  </footer>

  <button class="back-to-top" id="back-to-top" aria-label="Back to top" title="Back to top">&#8593;</button>

  ${buildExportScript()}
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Per-Category HTML ZIP Export
// ---------------------------------------------------------------------------

function buildSingleCategoryHtml(
  categoryName: string,
  categoryColor: string,
  bookmarks: BookmarkRow[],
  exportDate: Date
): string {
  const safeTitle = escapeHtml(categoryName)
  const safeDateLong = escapeHtml(formatExportDate(exportDate))
  const safeDateIso = exportDate.toISOString()

  const cardsHtml = bookmarks
    .map((b, i) => buildBookmarkCardHtml(b, i * 60))
    .join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle} — Siftly Export</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <style>${buildHtmlStyles()}</style>
</head>
<body>
  <header class="hero" role="banner">
    <div class="hero__brand">
      <span class="hero__brand-dot" aria-hidden="true" style="background:${escapeHtml(categoryColor)}"></span>
      Exported from Siftly
    </div>
    <h1 class="hero__title">${safeTitle}</h1>
    <div class="hero__meta" role="list">
      <div class="hero__meta-item" role="listitem">
        <span>Bookmarks</span>
        <span class="hero__meta-value">${bookmarks.length}</span>
      </div>
      <div class="hero__meta-item" role="listitem">
        <span>Exported</span>
        <time class="hero__meta-value" datetime="${safeDateIso}">${safeDateLong}</time>
      </div>
    </div>
  </header>

  <main class="main" id="main-content">
    <div class="bookmark-grid" role="list">
      ${cardsHtml}
    </div>
  </main>

  <footer class="site-footer" role="contentinfo">
    Exported from <a href="https://github.com/viperrcrypto/siftly" target="_blank" rel="noopener noreferrer">Siftly</a>
    &nbsp;&mdash;&nbsp;
    <time datetime="${safeDateIso}">${safeDateLong}</time>
  </footer>
</body>
</html>`
}

export async function exportCategoryHtmlZip(): Promise<Buffer> {
  const categories = await prisma.category.findMany({
    orderBy: { name: 'asc' },
  })

  const allBookmarks = await fetchBookmarksFull()
  const exportDate = new Date()

  // Group bookmarks by category slug
  const categoryMap = new Map<string, { name: string; color: string; bookmarks: BookmarkRow[] }>()

  for (const cat of categories) {
    categoryMap.set(cat.slug, { name: cat.name, color: cat.color, bookmarks: [] })
  }

  const uncategorized: BookmarkRow[] = []

  for (const bookmark of allBookmarks) {
    if (bookmark.categories.length === 0) {
      uncategorized.push(bookmark)
      continue
    }
    for (const { category } of bookmark.categories) {
      const entry = categoryMap.get(category.slug)
      if (entry) {
        entry.bookmarks.push(bookmark)
      }
    }
  }

  const JSZip = (await import('jszip')).default
  const zip = new JSZip()

  // One HTML file per category (skip empty categories)
  for (const [slug, entry] of categoryMap) {
    if (entry.bookmarks.length === 0) continue
    const html = buildSingleCategoryHtml(entry.name, entry.color, entry.bookmarks, exportDate)
    zip.file(`${slug}.html`, html)
  }

  if (uncategorized.length > 0) {
    const html = buildSingleCategoryHtml('Uncategorized', '#71717A', uncategorized, exportDate)
    zip.file('uncategorized.html', html)
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

// ---------------------------------------------------------------------------
// Analyzed HTML Export (AI-powered)
// ---------------------------------------------------------------------------

interface AnalysisResult {
  quickLinks: { title: string; url: string; source: string }[]
  actionItems: { title: string; description: string; source: string }[]
  products: { name: string; description: string; url?: string }[]
  insights: { title: string; description: string }[]
  summary: string
}

function buildAnalysisPrompt(bookmarks: BookmarkRow[]): string {
  const bookmarkData = bookmarks.map((b) => {
    const categories = b.categories.map((c) => c.category.name).join(', ')
    // Extract URLs from tweet text
    const urlMatches = b.text.match(/https?:\/\/[^\s)]+/g) || []
    return {
      author: `@${b.authorHandle}`,
      text: b.text.slice(0, 200),
      categories: categories || 'Uncategorized',
      urls: urlMatches.slice(0, 3),
    }
  })

  return `You are an expert analyst reviewing a curated collection of Twitter/X bookmarks. Analyze these bookmarks and extract structured insights.

BOOKMARKS (${bookmarks.length} total):
${JSON.stringify(bookmarkData, null, 1)}

Provide your analysis as JSON wrapped in \`\`\`json\`\`\` fences with this exact structure:

\`\`\`json
{
  "quickLinks": [
    {"title": "...", "url": "https://...", "source": "@handle"}
  ],
  "actionItems": [
    {"title": "...", "description": "...", "source": "@handle"}
  ],
  "products": [
    {"name": "...", "description": "...", "url": "https://..."}
  ],
  "insights": [
    {"title": "...", "description": "..."}
  ],
  "summary": "2-3 sentence overview of this bookmark collection"
}
\`\`\`

RULES:
- quickLinks: Extract up to 20 real URLs found in the bookmark texts. Title should describe the linked resource. Source is the tweet author.
- actionItems: Exactly 10 actionable takeaways from across the bookmarks. Be specific and practical. Source is the tweet author whose bookmark inspired this.
- products: Exactly 10 products, tools, platforms, or services mentioned across the bookmarks. Include a URL if one was mentioned.
- insights: Exactly 10 non-obvious or easily-missed insights. These are "you might have missed" takeaways that connect dots across multiple bookmarks or surface buried wisdom.
- summary: A concise 2-3 sentence overview describing what this collection covers and what makes it valuable.

Only include real URLs that appear in the bookmark data. Do not fabricate URLs.
Return ONLY the JSON block, no other text.`
}

function parseAnalysisResponse(text: string): AnalysisResult | null {
  // Try to extract JSON from ```json``` fences first
  const fencedMatch = text.match(/```json\s*([\s\S]*?)```/)
  const jsonStr = fencedMatch ? fencedMatch[1] : text

  // Try to find a JSON object
  const objectMatch = jsonStr.match(/\{[\s\S]*\}/)
  if (!objectMatch) return null

  try {
    const parsed = JSON.parse(objectMatch[0])

    return {
      quickLinks: Array.isArray(parsed.quickLinks) ? parsed.quickLinks.slice(0, 20) : [],
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.slice(0, 10) : [],
      products: Array.isArray(parsed.products) ? parsed.products.slice(0, 10) : [],
      insights: Array.isArray(parsed.insights) ? parsed.insights.slice(0, 10) : [],
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    }
  } catch {
    return null
  }
}

function buildAnalyzedHtmlStyles(): string {
  return `
    /* Sticky Table of Contents */
    .toc {
      position: sticky;
      top: 0;
      z-index: 100;
      background: rgba(10, 11, 13, 0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid #1E2028;
      padding: 0.75rem 1.25rem;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }

    .toc__inner {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      max-width: 1280px;
      margin: 0 auto;
      white-space: nowrap;
    }

    .toc__link {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      letter-spacing: 0.04em;
      color: #71717A;
      padding: 0.4rem 0.75rem;
      border-radius: 8px;
      border: 1px solid transparent;
      transition: all 0.2s ease;
      text-decoration: none;
      flex-shrink: 0;
    }

    .toc__link:hover {
      color: #E4E4E7;
      background: #131417;
      border-color: #1E2028;
      text-decoration: none;
    }

    .toc__link--purple:hover { color: #A855F7; border-color: #A855F730; }
    .toc__link--amber:hover { color: #F5A623; border-color: #F5A62330; }
    .toc__link--green:hover { color: #10B981; border-color: #10B98130; }
    .toc__link--cyan:hover { color: #06B6D4; border-color: #06B6D430; }

    /* Summary block */
    .summary-block {
      background: #131417;
      border: 1px solid #1E2028;
      border-radius: 16px;
      padding: 1.5rem 2rem;
      margin-bottom: 3rem;
      font-size: 1rem;
      line-height: 1.75;
      color: #D4D4D8;
      animation: fadeSlideUp 0.4s ease both;
    }

    .summary-block__label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.7rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #A855F7;
      margin-bottom: 0.5rem;
    }

    /* Section titles */
    .analysis-section-title {
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: #E4E4E7;
      margin-bottom: 1.5rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .analysis-section-title__icon {
      width: 32px;
      height: 32px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1rem;
      flex-shrink: 0;
    }

    .analysis-section-title__count {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      color: #71717A;
      background: #131417;
      border: 1px solid #1E2028;
      border-radius: 8px;
      padding: 0.2rem 0.55rem;
      margin-left: auto;
    }

    /* Quick Links grid */
    .quick-links-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0.75rem;
      margin-bottom: 3.5rem;
    }

    .quick-link-card {
      background: #131417;
      border: 1px solid #1E2028;
      border-radius: 12px;
      padding: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      animation: fadeSlideUp 0.4s ease both;
      text-decoration: none;
      cursor: pointer;
    }

    .quick-link-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4), 0 0 0 1px #06B6D420;
      text-decoration: none;
    }

    .quick-link-card__title {
      font-size: 0.85rem;
      font-weight: 600;
      color: #E4E4E7;
      line-height: 1.3;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .quick-link-card__domain {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.7rem;
      color: #06B6D4;
    }

    .quick-link-card__source {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.65rem;
      color: #52525B;
    }

    /* Analysis cards (action items) */
    .analysis-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 1rem;
      margin-bottom: 3.5rem;
    }

    .analysis-card {
      background: #131417;
      border: 1px solid #1E2028;
      border-radius: 14px;
      padding: 1.25rem;
      padding-left: 1.5rem;
      border-left: 3px solid #A855F7;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      animation: fadeSlideUp 0.4s ease both;
    }

    .analysis-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4), 0 0 0 1px #A855F720;
    }

    .analysis-card__number {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.7rem;
      font-weight: 600;
      color: #A855F7;
      letter-spacing: 0.05em;
    }

    .analysis-card__title {
      font-size: 0.95rem;
      font-weight: 600;
      color: #E4E4E7;
      line-height: 1.3;
    }

    .analysis-card__description {
      font-size: 0.85rem;
      line-height: 1.6;
      color: #A1A1AA;
    }

    .analysis-card__source {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.65rem;
      color: #52525B;
      margin-top: auto;
    }

    /* Product cards */
    .product-card {
      background: #131417;
      border: 1px solid #1E2028;
      border-radius: 14px;
      padding: 1.25rem;
      padding-left: 1.5rem;
      border-left: 3px solid #F5A623;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      animation: fadeSlideUp 0.4s ease both;
    }

    .product-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4), 0 0 0 1px #F5A62320;
    }

    .product-card__name {
      font-size: 0.95rem;
      font-weight: 600;
      color: #E4E4E7;
    }

    .product-card__description {
      font-size: 0.85rem;
      line-height: 1.6;
      color: #A1A1AA;
    }

    .product-card__link {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.72rem;
      color: #F5A623;
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      margin-top: auto;
    }

    .product-card__link:hover { color: #FFC560; text-decoration: none; }

    /* Insight cards */
    .insight-card {
      background: #131417;
      border: 1px solid #1E2028;
      border-radius: 14px;
      padding: 1.25rem;
      padding-left: 1.5rem;
      border-left: 3px solid #10B981;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      animation: fadeSlideUp 0.4s ease both;
    }

    .insight-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4), 0 0 0 1px #10B98120;
    }

    .insight-card__number {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.7rem;
      font-weight: 600;
      color: #10B981;
      letter-spacing: 0.05em;
    }

    .insight-card__title {
      font-size: 0.95rem;
      font-weight: 600;
      color: #E4E4E7;
      line-height: 1.3;
    }

    .insight-card__description {
      font-size: 0.85rem;
      line-height: 1.6;
      color: #A1A1AA;
    }

    /* Section divider */
    .section-divider {
      height: 1px;
      border: none;
      margin: 3rem 0;
      background: linear-gradient(90deg, transparent, #A855F740, #F5A62340, #10B98140, transparent);
    }

    /* Unavailable notice */
    .unavailable-notice {
      background: #131417;
      border: 1px solid #1E2028;
      border-radius: 12px;
      padding: 1.5rem 2rem;
      text-align: center;
      margin-bottom: 3rem;
      animation: fadeSlideUp 0.4s ease both;
    }

    .unavailable-notice__title {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #F5A623;
      margin-bottom: 0.5rem;
    }

    .unavailable-notice__text {
      font-size: 0.9rem;
      color: #71717A;
    }

    /* Responsive */
    @media (max-width: 768px) {
      .quick-links-grid { grid-template-columns: 1fr; }
      .analysis-grid { grid-template-columns: 1fr; }
    }

    @media (max-width: 480px) {
      .toc { padding: 0.5rem 0.75rem; }
      .toc__link { font-size: 0.7rem; padding: 0.3rem 0.5rem; }
      .summary-block { padding: 1rem 1.25rem; }
    }
  `
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.slice(0, 30)
  }
}

function buildQuickLinksHtml(links: AnalysisResult['quickLinks']): string {
  if (links.length === 0) return ''

  const cards = links.map((link, i) => {
    const safeTitle = escapeHtml(link.title)
    const safeUrl = escapeHtml(link.url)
    const domain = escapeHtml(extractDomain(link.url))
    const safeSource = escapeHtml(link.source)
    return `
      <a class="quick-link-card" href="${safeUrl}" target="_blank" rel="noopener noreferrer"
         style="animation-delay:${i * 40}ms">
        <span class="quick-link-card__title">${safeTitle}</span>
        <span class="quick-link-card__domain">${domain}</span>
        <span class="quick-link-card__source">${safeSource}</span>
      </a>`
  }).join('')

  return `
    <section id="quick-links" aria-labelledby="ql-title">
      <div class="analysis-section-title">
        <span class="analysis-section-title__icon" style="background:#06B6D415;color:#06B6D4">&#128279;</span>
        <h2 id="ql-title">Quick Links</h2>
        <span class="analysis-section-title__count">${links.length}</span>
      </div>
      <div class="quick-links-grid">${cards}</div>
    </section>`
}

function buildActionItemsHtml(items: AnalysisResult['actionItems']): string {
  if (items.length === 0) return ''

  const cards = items.map((item, i) => {
    const safeTitle = escapeHtml(item.title)
    const safeDesc = escapeHtml(item.description)
    const safeSource = escapeHtml(item.source)
    return `
      <div class="analysis-card" style="animation-delay:${i * 60}ms">
        <span class="analysis-card__number">#${i + 1}</span>
        <span class="analysis-card__title">${safeTitle}</span>
        <p class="analysis-card__description">${safeDesc}</p>
        <span class="analysis-card__source">via ${safeSource}</span>
      </div>`
  }).join('')

  return `
    <section id="action-items" aria-labelledby="ai-title">
      <div class="analysis-section-title">
        <span class="analysis-section-title__icon" style="background:#A855F715;color:#A855F7">&#9889;</span>
        <h2 id="ai-title">Top 10 Action Items</h2>
        <span class="analysis-section-title__count">${items.length}</span>
      </div>
      <div class="analysis-grid">${cards}</div>
    </section>`
}

function buildProductsHtml(products: AnalysisResult['products']): string {
  if (products.length === 0) return ''

  const cards = products.map((product, i) => {
    const safeName = escapeHtml(product.name)
    const safeDesc = escapeHtml(product.description)
    const linkHtml = product.url
      ? `<a class="product-card__link" href="${escapeHtml(product.url)}" target="_blank" rel="noopener noreferrer">Visit &#8599;</a>`
      : ''
    return `
      <div class="product-card" style="animation-delay:${i * 60}ms">
        <span class="product-card__name">${safeName}</span>
        <p class="product-card__description">${safeDesc}</p>
        ${linkHtml}
      </div>`
  }).join('')

  return `
    <section id="products" aria-labelledby="prod-title">
      <div class="analysis-section-title">
        <span class="analysis-section-title__icon" style="background:#F5A62315;color:#F5A623">&#128736;</span>
        <h2 id="prod-title">Top 10 Products &amp; Tools</h2>
        <span class="analysis-section-title__count">${products.length}</span>
      </div>
      <div class="analysis-grid">${cards}</div>
    </section>`
}

function buildInsightsHtml(insights: AnalysisResult['insights']): string {
  if (insights.length === 0) return ''

  const cards = insights.map((insight, i) => {
    const safeTitle = escapeHtml(insight.title)
    const safeDesc = escapeHtml(insight.description)
    return `
      <div class="insight-card" style="animation-delay:${i * 60}ms">
        <span class="insight-card__number">#${i + 1}</span>
        <span class="insight-card__title">${safeTitle}</span>
        <p class="insight-card__description">${safeDesc}</p>
      </div>`
  }).join('')

  return `
    <section id="insights" aria-labelledby="ins-title">
      <div class="analysis-section-title">
        <span class="analysis-section-title__icon" style="background:#10B98115;color:#10B981">&#128161;</span>
        <h2 id="ins-title">Hidden Insights</h2>
        <span class="analysis-section-title__count">${insights.length}</span>
      </div>
      <div class="analysis-grid">${cards}</div>
    </section>`
}

export async function exportBookmarksAnalyzedHtml(
  bookmarkIds?: string[],
  title?: string
): Promise<string> {
  const where =
    bookmarkIds && bookmarkIds.length > 0
      ? { id: { in: bookmarkIds } }
      : undefined

  const bookmarks = await fetchBookmarksFull(where)

  const exportTitle = title || 'My Curated Bookmarks'
  const exportDate = new Date()

  // --- AI Analysis ---
  let analysis: AnalysisResult | null = null

  if (bookmarks.length > 0) {
    try {
      const prompt = buildAnalysisPrompt(bookmarks)
      let responseText: string | null = null

      // Prefer CLI over SDK (same pattern as categorizer.ts)
      if (await getCliAvailability()) {
        const modelSetting = await getAnthropicModel()
        const cliModel = modelNameToCliAlias(modelSetting)

        const result = await claudePrompt(prompt, { model: cliModel, timeoutMs: 120_000 })
        if (result.success && result.data) {
          responseText = result.data
        }
      }

      // Fall back to SDK if CLI unavailable or failed
      if (!responseText) {
        try {
          const dbSetting = await prisma.setting.findUnique({ where: { key: 'anthropicApiKey' } })
          const client = resolveAnthropicClient({ dbKey: dbSetting?.value ?? undefined })
          const modelSetting = await getAnthropicModel()

          const message = await client.messages.create({
            model: modelSetting,
            max_tokens: 4096,
            messages: [{ role: 'user', content: prompt }],
          })

          const textBlock = message.content.find((b) => b.type === 'text')
          if (textBlock && textBlock.type === 'text') {
            responseText = textBlock.text
          }
        } catch {
          // SDK also failed — analysis will be null
        }
      }

      if (responseText) {
        analysis = parseAnalysisResponse(responseText)
      }
    } catch {
      // AI analysis failed entirely — continue without it
      analysis = null
    }
  }

  // --- Group bookmarks by category (same logic as exportBookmarksHtml) ---
  const categoryMap = new Map<string, { name: string; color: string; bookmarks: BookmarkRow[] }>()

  for (const bookmark of bookmarks) {
    if (bookmark.categories.length === 0) {
      continue
    }
    for (const { category } of bookmark.categories) {
      if (!categoryMap.has(category.slug)) {
        categoryMap.set(category.slug, {
          name: category.name,
          color: category.color,
          bookmarks: [],
        })
      }
      categoryMap.get(category.slug)!.bookmarks.push(bookmark)
    }
  }

  const uncategorized = bookmarks.filter((b) => b.categories.length === 0)

  let cardOffset = 0
  const bookmarkSectionsHtml: string[] = []

  for (const entry of categoryMap.values()) {
    bookmarkSectionsHtml.push(
      buildCategorySectionHtml(entry.name, entry.color, entry.bookmarks, cardOffset)
    )
    cardOffset += entry.bookmarks.length
  }

  if (uncategorized.length > 0) {
    bookmarkSectionsHtml.push(
      buildCategorySectionHtml('Uncategorized', '#71717A', uncategorized, cardOffset)
    )
  }

  const categoryCount = categoryMap.size + (uncategorized.length > 0 ? 1 : 0)

  // --- Build HTML ---
  const safeTitle = escapeHtml(exportTitle)
  const safeDateLong = escapeHtml(formatExportDate(exportDate))
  const safeDateIso = exportDate.toISOString()

  const heroSubtitle = analysis
    ? 'AI-analyzed and organized by Siftly'
    : 'Exported from Siftly'

  // Build analysis sections or unavailable notice
  let analysisSectionsHtml = ''
  if (analysis) {
    const summaryHtml = analysis.summary
      ? `<div class="summary-block">
          <div class="summary-block__label">AI Summary</div>
          ${escapeHtml(analysis.summary)}
        </div>`
      : ''

    analysisSectionsHtml = `
      ${summaryHtml}
      ${buildQuickLinksHtml(analysis.quickLinks)}
      ${buildActionItemsHtml(analysis.actionItems)}
      ${buildProductsHtml(analysis.products)}
      ${buildInsightsHtml(analysis.insights)}
      <hr class="section-divider" />`
  } else {
    analysisSectionsHtml = `
      <div class="unavailable-notice">
        <div class="unavailable-notice__title">AI Analysis Unavailable</div>
        <p class="unavailable-notice__text">
          Could not generate AI analysis for this export. This may be due to rate limiting,
          missing API key, or the AI service being temporarily unavailable.
          The full bookmark list is included below.
        </p>
      </div>`
  }

  // TOC nav
  const tocLinks = analysis
    ? `
      <a class="toc__link toc__link--cyan" href="#quick-links">Quick Links</a>
      <a class="toc__link toc__link--purple" href="#action-items">Action Items</a>
      <a class="toc__link toc__link--amber" href="#products">Products</a>
      <a class="toc__link toc__link--green" href="#insights">Insights</a>
      <a class="toc__link" href="#full-bookmarks">Full Bookmarks</a>`
    : `<a class="toc__link" href="#full-bookmarks">Full Bookmarks</a>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <style>
    ${buildHtmlStyles()}
    ${buildAnalyzedHtmlStyles()}
  </style>
</head>
<body>
  <header class="hero" role="banner">
    <div class="hero__brand">
      <span class="hero__brand-dot" aria-hidden="true"></span>
      ${escapeHtml(heroSubtitle)}
    </div>
    <h1 class="hero__title">${safeTitle}</h1>
    <div class="hero__meta" role="list">
      <div class="hero__meta-item" role="listitem">
        <span>Bookmarks</span>
        <span class="hero__meta-value">${bookmarks.length}</span>
      </div>
      <div class="hero__meta-item" role="listitem">
        <span>Categories</span>
        <span class="hero__meta-value">${categoryCount}</span>
      </div>
      <div class="hero__meta-item" role="listitem">
        <span>Exported</span>
        <time class="hero__meta-value" datetime="${safeDateIso}">${safeDateLong}</time>
      </div>
    </div>
  </header>

  <nav class="toc" role="navigation" aria-label="Table of contents">
    <div class="toc__inner">
      ${tocLinks}
    </div>
  </nav>

  <main class="main" id="main-content">
    ${analysisSectionsHtml}

    <section id="full-bookmarks">
      <div class="analysis-section-title" style="margin-top:1rem">
        <h2>Full Bookmarks</h2>
        <span class="analysis-section-title__count">${bookmarks.length}</span>
      </div>
      ${bookmarkSectionsHtml.join('\n')}
    </section>
  </main>

  <footer class="site-footer" role="contentinfo">
    Exported from <a href="https://github.com/viperrcrypto/siftly" target="_blank" rel="noopener noreferrer">Siftly</a>
    &nbsp;&mdash;&nbsp;
    <time datetime="${safeDateIso}">${safeDateLong}</time>
  </footer>
</body>
</html>`
}
