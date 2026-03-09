'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Download,
  FileText,
  Code,
  CheckSquare,
  Square,
  Search,
  X,
  FileCode,
  ChevronDown,
  BookmarkX,
  Bookmark,
  ImageOff,
  Sparkles,
} from 'lucide-react'
import * as Select from '@radix-ui/react-select'
import type { BookmarkWithMedia, BookmarksResponse, Category } from '@/lib/types'

// ── Constants ──────────────────────────────────────────────────────────────────

const LOAD_LIMIT = 100

// ── Helpers ────────────────────────────────────────────────────────────────────

function proxyUrl(url: string): string {
  return `/api/media?url=${encodeURIComponent(url)}`
}

function isVideoUrl(url: string): boolean {
  return url.includes('video.twimg.com') || url.includes('.mp4')
}

const TCO_REGEX = /https?:\/\/t\.co\/[^\s]+/g

function stripTcoUrls(text: string): string {
  return text.replace(TCO_REGEX, '').trim()
}

// ── Select dropdown (matches bookmarks page pattern) ──────────────────────────

function SelectMenu({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  options: { label: string; value: string }[]
  placeholder: string
}) {
  return (
    <Select.Root value={value || '_all'} onValueChange={(v) => onChange(v === '_all' ? '' : v)}>
      <Select.Trigger className="flex items-center gap-2 px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-sm text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 focus:outline-none focus:border-indigo-500 transition-all min-w-[140px] shrink-0">
        <Select.Value placeholder={placeholder} />
        <Select.Icon className="ml-auto">
          <ChevronDown size={12} className="text-zinc-600" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="z-50 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl shadow-black/50 overflow-hidden">
          <Select.Viewport className="p-1">
            <Select.Item
              value="_all"
              className="flex items-center px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 rounded-lg cursor-pointer outline-none transition-colors data-[highlighted]:bg-zinc-800 data-[highlighted]:text-zinc-100"
            >
              <Select.ItemText>{placeholder}</Select.ItemText>
            </Select.Item>
            {options.map((opt) => (
              <Select.Item
                key={opt.value}
                value={opt.value}
                className="flex items-center px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 rounded-lg cursor-pointer outline-none transition-colors data-[highlighted]:bg-zinc-800 data-[highlighted]:text-zinc-100"
              >
                <Select.ItemText>{opt.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}

// ── Skeleton card ──────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="masonry-item">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden animate-pulse">
        <div className="h-40 bg-zinc-800" />
        <div className="p-4">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-8 h-8 rounded-full bg-zinc-800" />
            <div className="space-y-1.5">
              <div className="w-24 h-3 rounded-lg bg-zinc-800" />
              <div className="w-16 h-2.5 rounded-lg bg-zinc-800" />
            </div>
          </div>
          <div className="space-y-2">
            <div className="w-full h-3 rounded-lg bg-zinc-800" />
            <div className="w-5/6 h-3 rounded-lg bg-zinc-800" />
            <div className="w-3/4 h-3 rounded-lg bg-zinc-800" />
          </div>
          <div className="mt-4 pt-3 border-t border-zinc-800 flex gap-2">
            <div className="w-16 h-5 rounded-full bg-zinc-800" />
            <div className="w-20 h-5 rounded-full bg-zinc-800" />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Selectable bookmark card ───────────────────────────────────────────────────

interface SelectableCardProps {
  bookmark: BookmarkWithMedia
  selected: boolean
  onToggle: (id: string) => void
}

function SelectableCard({ bookmark, selected, onToggle }: SelectableCardProps) {
  const [imgError, setImgError] = useState(false)
  const firstMedia = bookmark.mediaItems[0] ?? null
  const cleanText = stripTcoUrls(bookmark.text)
  const isKnownAuthor = bookmark.authorHandle !== 'unknown'

  function handleCardClick() {
    onToggle(bookmark.id)
  }

  return (
    <div
      onClick={handleCardClick}
      className={`
        masonry-item group relative bg-zinc-900 rounded-2xl overflow-hidden flex flex-col flex-1 cursor-pointer
        transition-all duration-150 select-none
        ${selected
          ? 'border-2 border-indigo-500 shadow-lg shadow-indigo-500/20 ring-1 ring-indigo-500/30'
          : 'border border-zinc-800 hover:border-zinc-700 hover:shadow-xl hover:shadow-black/30'
        }
      `}
      role="checkbox"
      aria-checked={selected}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          onToggle(bookmark.id)
        }
      }}
    >
      {/* Checkbox overlay — top-left corner */}
      <div
        className="absolute top-2.5 left-2.5 z-10"
        onClick={(e) => { e.stopPropagation(); onToggle(bookmark.id) }}
      >
        <div
          className={`
            w-6 h-6 rounded-lg flex items-center justify-center transition-all duration-150 shadow-md
            ${selected
              ? 'bg-indigo-500 border-2 border-indigo-400'
              : 'bg-zinc-900/80 border-2 border-zinc-600 group-hover:border-zinc-400 backdrop-blur-sm'
            }
          `}
        >
          {selected
            ? <CheckSquare size={14} className="text-white" />
            : <Square size={14} className="text-zinc-500 group-hover:text-zinc-300 transition-colors" />
          }
        </div>
      </div>

      {/* Selected tint overlay */}
      {selected && (
        <div className="absolute inset-0 bg-indigo-500/5 pointer-events-none z-[1]" />
      )}

      {/* Top media — full bleed */}
      {firstMedia && (
        <div className="border-b border-zinc-800/60 flex-shrink-0 relative">
          {firstMedia.type === 'photo' && !imgError ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={proxyUrl(firstMedia.url)}
              alt="Bookmark media"
              className="w-full h-40 object-cover"
              loading="lazy"
              onError={() => setImgError(true)}
            />
          ) : firstMedia.type === 'photo' && imgError ? (
            <div className="h-40 flex items-center justify-center bg-zinc-800/70">
              <ImageOff size={18} className="text-zinc-600" />
            </div>
          ) : (() => {
            const rawThumb = firstMedia.thumbnailUrl ?? null
            const thumb = rawThumb && !isVideoUrl(rawThumb) ? rawThumb
              : (!isVideoUrl(firstMedia.url) ? firstMedia.url : null)
            return thumb && !imgError ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={proxyUrl(thumb)}
                alt=""
                className="w-full h-40 object-cover"
                loading="lazy"
                onError={() => setImgError(true)}
              />
            ) : (
              <div className="h-40 flex items-center justify-center bg-zinc-800/70">
                <span className="px-3 py-1.5 rounded-full bg-zinc-700 text-zinc-300 text-xs font-semibold">
                  Video
                </span>
              </div>
            )
          })()}
        </div>
      )}

      {/* Card body */}
      <div className="p-4 flex flex-col flex-1">
        {/* Author row */}
        <div className="flex items-center gap-2 mb-2 min-w-0">
          <div className="min-w-0">
            {isKnownAuthor && (
              <p className="text-xs text-zinc-500 truncate">@{bookmark.authorHandle}</p>
            )}
          </div>
        </div>

        {/* Tweet text — capped at 3 lines */}
        <p className="text-sm text-zinc-200 leading-relaxed line-clamp-3 flex-1 min-h-[3.75rem]">
          {cleanText || <span className="text-zinc-600 italic">No text content</span>}
        </p>

        {/* Category pills */}
        {bookmark.categories.length > 0 && (
          <div className="mt-3 pt-3 border-t border-zinc-800/50 flex flex-wrap gap-1.5">
            {bookmark.categories.slice(0, 3).map((cat) => (
              <span
                key={cat.id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
                style={{
                  backgroundColor: `${cat.color}18`,
                  color: cat.color,
                  border: `1px solid ${cat.color}30`,
                }}
              >
                <Bookmark
                  size={9}
                  className="flex-shrink-0"
                  style={{ color: cat.color, fill: cat.color }}
                />
                {cat.name}
              </span>
            ))}
            {bookmark.categories.length > 3 && (
              <span className="text-xs text-zinc-600">+{bookmark.categories.length - 3}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Export button ──────────────────────────────────────────────────────────────

interface ExportButtonProps {
  label: string
  icon: React.ReactNode
  onClick: () => void
  disabled: boolean
  loading: boolean
  className?: string
}

function ExportButton({ label, icon, onClick, disabled, loading, className }: ExportButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={`flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-all shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/30 ${className ?? ''}`}
    >
      {loading ? (
        <div className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
      ) : (
        icon
      )}
      {label}
    </button>
  )
}

// ── Confirm modal ──────────────────────────────────────────────────────────────

interface ConfirmModalProps {
  total: number
  exportType: 'html' | 'html-analyzed' | 'csv' | 'json'
  onConfirm: () => void
  onCancel: () => void
}

function ConfirmModal({ total, exportType, onConfirm, onCancel }: ConfirmModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-zinc-900 border border-zinc-800 rounded-2xl p-6 max-w-sm w-full shadow-2xl shadow-black/50">
        <h3 className="text-base font-semibold text-zinc-100 mb-2">Export all bookmarks?</h3>
        <p className="text-sm text-zinc-400 mb-5">
          No bookmarks are selected. This will export all{' '}
          <span className="text-zinc-200 font-medium">{total.toLocaleString()}</span>{' '}
          bookmarks as <span className="text-indigo-300 font-medium uppercase">{exportType}</span>.
        </p>
        <div className="flex items-center justify-end gap-2.5">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-xl text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors border border-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-xl text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
          >
            Export all
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function ExportPage() {
  // Bookmarks state
  const [bookmarks, setBookmarks] = useState<BookmarkWithMedia[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [offset, setOffset] = useState(0)
  const hasMore = bookmarks.length < total

  // Filter state
  const [searchInput, setSearchInput] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('')
  const [categories, setCategories] = useState<Category[]>([])

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Export state
  const [exportingType, setExportingType] = useState<'html' | 'html-analyzed' | 'csv' | 'json' | null>(null)
  const [confirmExport, setConfirmExport] = useState<'html' | 'html-analyzed' | 'csv' | 'json' | null>(null)

  // Title for HTML export
  const [exportTitle, setExportTitle] = useState('My Curated Bookmarks')

  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Debounce search ──────────────────────────────────────────────────────────

  function handleSearchChange(value: string) {
    setSearchInput(value)
    if (searchRef.current) clearTimeout(searchRef.current)
    searchRef.current = setTimeout(() => {
      setDebouncedSearch(value)
    }, 300)
  }

  // ── Fetch categories ─────────────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/categories')
      .then((r) => r.json())
      .then((data: { categories: Category[] }) => setCategories(data.categories))
      .catch(() => setCategories([]))
  }, [])

  // ── Fetch bookmarks (initial load / filter change) ───────────────────────────

  const fetchBookmarks = useCallback(async (reset: boolean = true) => {
    if (reset) {
      setLoading(true)
      setOffset(0)
    } else {
      setLoadingMore(true)
    }

    const currentOffset = reset ? 0 : offset

    try {
      const params = new URLSearchParams()
      params.set('limit', String(LOAD_LIMIT))
      params.set('offset', String(currentOffset))
      if (debouncedSearch) params.set('q', debouncedSearch)
      if (selectedCategory) params.set('category', selectedCategory)
      params.set('sort', 'newest')

      const res = await fetch(`/api/bookmarks?${params.toString()}`)
      if (!res.ok) throw new Error('Failed to fetch bookmarks')
      const data: BookmarksResponse = await res.json()

      if (reset) {
        setBookmarks(data.bookmarks)
        // Clear selection when filters change
        setSelectedIds(new Set())
      } else {
        setBookmarks((prev) => [...prev, ...data.bookmarks])
      }
      setTotal(data.total)
      setOffset(currentOffset + data.bookmarks.length)
    } catch (err) {
      console.error('Failed to load bookmarks:', err)
      if (reset) {
        setBookmarks([])
        setTotal(0)
      }
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, selectedCategory])

  useEffect(() => {
    fetchBookmarks(true)
  }, [fetchBookmarks])

  // ── Load more ─────────────────────────────────────────────────────────────────

  async function loadMore() {
    if (loadingMore || !hasMore) return
    await fetchBookmarks(false)
  }

  // ── Selection helpers ─────────────────────────────────────────────────────────

  function toggleBookmark(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectAll() {
    setSelectedIds(new Set(bookmarks.map((b) => b.id)))
  }

  function deselectAll() {
    setSelectedIds(new Set())
  }

  function selectAllInCategory() {
    if (!selectedCategory) return
    const inCategory = bookmarks.filter((b) =>
      b.categories.some((c) => c.slug === selectedCategory)
    )
    setSelectedIds(new Set(inCategory.map((b) => b.id)))
  }

  const selectedCount = selectedIds.size
  const allSelected = bookmarks.length > 0 && selectedIds.size === bookmarks.length

  // ── Export logic ──────────────────────────────────────────────────────────────

  async function doExport(type: 'html' | 'html-analyzed' | 'csv' | 'json', ids: string[]) {
    setExportingType(type)
    setConfirmExport(null)

    try {
      const body: { type: string; bookmarkIds: string[]; title?: string } = {
        type,
        bookmarkIds: ids,
      }
      if (type === 'html' || type === 'html-analyzed') body.title = exportTitle

      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error((errData as { error?: string }).error ?? `Export failed (${res.status})`)
      }

      // Derive filename from Content-Disposition or fall back to default
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const filenameMatch = disposition.match(/filename="?([^"]+)"?/)
      const ext = type === 'html' ? 'html' : type === 'csv' ? 'csv' : 'json'
      const filename = filenameMatch?.[1] ?? `siftly-bookmarks.${ext}`

      // Trigger file download
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Export error:', err)
      // Surface error briefly — could be upgraded to a toast later
      alert(err instanceof Error ? err.message : 'Export failed. Please try again.')
    } finally {
      setExportingType(null)
    }
  }

  function handleExport(type: 'html' | 'html-analyzed' | 'csv' | 'json') {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) {
      // Nothing selected — confirm before exporting all
      setConfirmExport(type)
      return
    }
    doExport(type, ids)
  }

  // ── Category options for the dropdown ─────────────────────────────────────────

  const categoryOptions = categories.map((c) => ({
    label: c.name,
    value: c.slug,
  }))

  const isExporting = exportingType !== null

  return (
    <div className="flex flex-col h-full">

      {/* ── Sticky top bar ── */}
      <div className="sticky top-0 z-20 bg-zinc-950/90 backdrop-blur-lg border-b border-zinc-800/60">
        <div className="px-6 md:px-8 py-4">

          {/* Row 1: title + export controls */}
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-base font-semibold text-zinc-100 shrink-0 mr-1">Export Bookmarks</h1>

            {/* Search */}
            <div className="relative flex-1 min-w-[160px]">
              <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-600 pointer-events-none" />
              <input
                type="text"
                placeholder="Search bookmarks..."
                value={searchInput}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="w-full pl-9 pr-8 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-100 placeholder:text-zinc-600 text-sm focus:outline-none focus:border-indigo-500/60 focus:ring-1 focus:ring-indigo-500/20 transition-all"
              />
              {searchInput && (
                <button
                  onClick={() => handleSearchChange('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300 transition-colors"
                  aria-label="Clear search"
                >
                  <X size={13} />
                </button>
              )}
            </div>

            {/* Category filter */}
            <SelectMenu
              value={selectedCategory}
              onChange={(v) => setSelectedCategory(v)}
              options={categoryOptions}
              placeholder="All categories"
            />

            {/* Divider */}
            <div className="h-6 w-px bg-zinc-800 shrink-0 hidden sm:block" />

            {/* Export buttons */}
            <div className="flex items-center gap-2 flex-wrap">
              <ExportButton
                label="HTML"
                icon={<FileText size={14} />}
                onClick={() => handleExport('html')}
                disabled={isExporting}
                loading={exportingType === 'html'}
              />
              <ExportButton
                label="AI Report"
                icon={<Sparkles size={14} />}
                onClick={() => handleExport('html-analyzed')}
                disabled={isExporting}
                loading={exportingType === 'html-analyzed'}
                className="!bg-purple-600/20 !border-purple-500/30 !text-purple-300 hover:!bg-purple-600/30 hover:!border-purple-500/50"
              />
              <ExportButton
                label="CSV"
                icon={<FileCode size={14} />}
                onClick={() => handleExport('csv')}
                disabled={isExporting}
                loading={exportingType === 'csv'}
              />
              <ExportButton
                label="JSON"
                icon={<Code size={14} />}
                onClick={() => handleExport('json')}
                disabled={isExporting}
                loading={exportingType === 'json'}
              />
            </div>
          </div>

          {/* Row 2: selection controls + HTML title input */}
          <div className="flex items-center gap-3 mt-3 flex-wrap">

            {/* Selection count badge */}
            <span className="text-sm text-zinc-500 shrink-0">
              {selectedCount > 0 ? (
                <>
                  <span className="text-indigo-300 font-semibold">{selectedCount.toLocaleString()}</span>
                  <span className="text-zinc-600"> of </span>
                  <span className="text-zinc-300 font-medium">{bookmarks.length.toLocaleString()}</span>
                  <span className="text-zinc-600"> selected</span>
                </>
              ) : (
                <span className="text-zinc-600">
                  {loading ? 'Loading…' : `${total.toLocaleString()} bookmark${total !== 1 ? 's' : ''}`}
                </span>
              )}
            </span>

            {/* Select / deselect buttons */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={allSelected ? deselectAll : selectAll}
                disabled={bookmarks.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-900 border border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              >
                {allSelected ? (
                  <>
                    <CheckSquare size={12} className="text-indigo-400" />
                    Deselect all
                  </>
                ) : (
                  <>
                    <Square size={12} />
                    Select all
                  </>
                )}
              </button>

              {selectedCount > 0 && !allSelected && (
                <button
                  onClick={deselectAll}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-900 border border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300 transition-all"
                >
                  <X size={12} />
                  Clear
                </button>
              )}

              {selectedCategory && (
                <button
                  onClick={selectAllInCategory}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-900 border border-zinc-800 text-zinc-400 hover:border-indigo-500/50 hover:text-indigo-300 hover:border-indigo-500/40 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                  disabled={bookmarks.length === 0}
                >
                  <CheckSquare size={12} />
                  Select category
                </button>
              )}
            </div>

            {/* HTML title input — shown on right side */}
            <div className="flex items-center gap-2 ml-auto">
              <label htmlFor="export-title" className="text-xs text-zinc-600 shrink-0 hidden md:block">
                HTML title:
              </label>
              <input
                id="export-title"
                type="text"
                value={exportTitle}
                onChange={(e) => setExportTitle(e.target.value)}
                placeholder="My Curated Bookmarks"
                className="w-52 px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 placeholder:text-zinc-600 text-sm focus:outline-none focus:border-indigo-500/60 focus:ring-1 focus:ring-indigo-500/20 transition-all"
              />
            </div>

          </div>

        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 px-6 md:px-8 py-6 max-w-7xl mx-auto w-full">

        {/* Loading skeletons */}
        {loading && (
          <div className="masonry-grid">
            {Array.from({ length: 12 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        )}

        {/* Empty state */}
        {!loading && bookmarks.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-16 h-16 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-5">
              <BookmarkX size={26} className="text-zinc-700" />
            </div>
            <h3 className="text-base font-semibold text-zinc-400 mb-2">No bookmarks found</h3>
            <p className="text-zinc-600 text-sm mb-5 max-w-xs">
              Try adjusting your search or category filter.
            </p>
            {(searchInput || selectedCategory) && (
              <button
                onClick={() => { handleSearchChange(''); setSelectedCategory('') }}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 rounded-xl transition-colors border border-zinc-800"
              >
                <X size={13} />
                Clear filters
              </button>
            )}
          </div>
        )}

        {/* Masonry grid */}
        {!loading && bookmarks.length > 0 && (
          <>
            <div className="masonry-grid">
              {bookmarks.map((bookmark) => (
                <SelectableCard
                  key={bookmark.id}
                  bookmark={bookmark}
                  selected={selectedIds.has(bookmark.id)}
                  onToggle={toggleBookmark}
                />
              ))}
            </div>

            {/* Load more */}
            {hasMore && (
              <div className="flex justify-center mt-10">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-medium bg-zinc-900 border border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  {loadingMore ? (
                    <>
                      <div className="w-3.5 h-3.5 rounded-full border-2 border-zinc-600 border-t-zinc-300 animate-spin" />
                      Loading…
                    </>
                  ) : (
                    <>
                      <Download size={14} />
                      Load more ({(total - bookmarks.length).toLocaleString()} remaining)
                    </>
                  )}
                </button>
              </div>
            )}

            {/* Loaded all indicator */}
            {!hasMore && bookmarks.length > LOAD_LIMIT && (
              <p className="text-center text-xs text-zinc-700 mt-8">
                All {total.toLocaleString()} bookmarks loaded
              </p>
            )}
          </>
        )}

      </div>

      {/* ── Confirm export-all modal ── */}
      {confirmExport && (
        <ConfirmModal
          total={total}
          exportType={confirmExport}
          onConfirm={() => {
            // Export all: send empty array → server interprets as "all"
            doExport(confirmExport, [])
          }}
          onCancel={() => setConfirmExport(null)}
        />
      )}

    </div>
  )
}
