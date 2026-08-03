import { NextRequest, NextResponse } from 'next/server'
import { exportAllBookmarksCsv, exportBookmarksJson, exportCategoryAsZip, exportBookmarksHtml, exportBookmarksAnalyzedHtml, exportBookmarksMarkdown } from '@/lib/exporter'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const type = searchParams.get('type')
  const categorySlug = searchParams.get('category')

  if (!type) {
    return NextResponse.json(
      { error: 'Missing required query param: type (csv | json | zip)' },
      { status: 400 }
    )
  }

  if (type === 'csv') {
    try {
      const csv = await exportAllBookmarksCsv()
      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="bookmarks.csv"',
        },
      })
    } catch (err) {
      console.error('CSV export error:', err)
      return NextResponse.json(
        { error: `Failed to export CSV: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 }
      )
    }
  }

  if (type === 'json') {
    try {
      const json = await exportBookmarksJson()
      return new NextResponse(json, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="bookmarks.json"',
        },
      })
    } catch (err) {
      console.error('JSON export error:', err)
      return NextResponse.json(
        { error: `Failed to export JSON: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 }
      )
    }
  }

  if (type === 'zip') {
    try {
      let zipBuffer: Buffer

      if (categorySlug) {
        zipBuffer = await exportCategoryAsZip(categorySlug)
        const safeSlug = categorySlug.replace(/[^a-z0-9-_]/gi, '_')
        return new NextResponse(new Uint8Array(zipBuffer), {
          status: 200,
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="bookmarks-${safeSlug}.zip"`,
          },
        })
      }

      // ZIP of all bookmarks — export category by category; for simplicity export all JSON as zip
      const json = await exportBookmarksJson()
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()
      zip.file('bookmarks.json', json)
      zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })

      return new NextResponse(new Uint8Array(zipBuffer), {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="bookmarks-all.zip"',
        },
      })
    } catch (err) {
      console.error('ZIP export error:', err)
      return NextResponse.json(
        { error: `Failed to export ZIP: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 }
      )
    }
  }

  return NextResponse.json(
    { error: `Unknown export type: ${type}. Use csv, json, zip, or html.` },
    { status: 400 }
  )
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { type?: string; bookmarkIds?: string[]; title?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { type, bookmarkIds, title } = body

  if (!type) {
    return NextResponse.json(
      { error: 'Missing required field: type (csv | json | html)' },
      { status: 400 }
    )
  }

  const ids = bookmarkIds && bookmarkIds.length > 0 ? bookmarkIds : undefined

  if (type === 'csv') {
    try {
      const csv = await exportAllBookmarksCsv(ids)
      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="siftly-bookmarks.csv"',
        },
      })
    } catch (err) {
      console.error('CSV export error:', err)
      return NextResponse.json({ error: 'An error occurred' }, { status: 500 })
    }
  }

  if (type === 'json') {
    try {
      const json = await exportBookmarksJson(ids)
      return new NextResponse(json, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="siftly-bookmarks.json"',
        },
      })
    } catch (err) {
      console.error('JSON export error:', err)
      return NextResponse.json({ error: 'An error occurred' }, { status: 500 })
    }
  }

  if (type === 'html') {
    try {
      const html = await exportBookmarksHtml(ids, title)
      return new NextResponse(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': 'attachment; filename="siftly-bookmarks.html"',
        },
      })
    } catch (err) {
      console.error('HTML export error:', err)
      return NextResponse.json({ error: 'An error occurred' }, { status: 500 })
    }
  }

  if (type === 'html-analyzed') {
    try {
      const html = await exportBookmarksAnalyzedHtml(ids, title)
      return new NextResponse(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': 'attachment; filename="siftly-bookmarks-analyzed.html"',
        },
      })
    } catch (err) {
      console.error('Analyzed HTML export error:', err)
      return NextResponse.json({ error: 'An error occurred' }, { status: 500 })
    }
  }

  if (type === 'markdown') {
    try {
      const md = await exportBookmarksMarkdown(ids)
      return new NextResponse(md, {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': 'attachment; filename="siftly-bookmarks.md"',
        },
      })
    } catch (err) {
      console.error('Markdown export error:', err)
      return NextResponse.json({ error: 'An error occurred' }, { status: 500 })
    }
  }

  return NextResponse.json(
    { error: `Unknown export type: ${type}. Use csv, json, html, html-analyzed, or markdown.` },
    { status: 400 }
  )
}
