import {
  mdiArchiveOutline,
  mdiCodeBraces,
  mdiFileDocumentOutline,
  mdiFileImageOutline,
  mdiFileOutline,
  mdiFilePdfBox,
  mdiFileVideoOutline,
  mdiFolderOutline,
  mdiLanguageMarkdownOutline,
  mdiSourceRepository,
} from '@mdi/js';
import type { FileContent, TreeEntry } from '@conclavix/core';
import { languageOf } from './highlight';
import type { DiffLine } from './logic';

/** Largest file the API serves raw for an inline preview (`MAX_RAW_BYTES` in core). */
export const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1);
};

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const VIDEO = new Set(['mp4', 'webm']);
const ARCHIVE = new Set(['zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar', 'jar']);
const MARKDOWN = new Set(['md', 'markdown']);

export type FileKind = 'image' | 'video' | 'pdf' | 'markdown' | 'archive' | 'code' | 'file';

/** What kind of file `path` is, by its extension. */
export function fileKind(path: string): FileKind {
  const extension = extensionOf(path);
  if (IMAGE.has(extension)) return 'image';
  if (VIDEO.has(extension)) return 'video';
  if (extension === 'pdf') return 'pdf';
  if (MARKDOWN.has(extension)) return 'markdown';
  if (ARCHIVE.has(extension)) return 'archive';
  return languageOf(path) ? 'code' : 'file';
}

const KIND_ICONS: Record<FileKind, string> = {
  image: mdiFileImageOutline,
  video: mdiFileVideoOutline,
  pdf: mdiFilePdfBox,
  markdown: mdiLanguageMarkdownOutline,
  archive: mdiArchiveOutline,
  code: mdiCodeBraces,
  file: mdiFileDocumentOutline,
};

/** The icon of a tree entry: folders, submodules and files by kind. */
export function entryIcon(entry: Pick<TreeEntry, 'type' | 'path'>): string {
  if (entry.type === 'tree') return mdiFolderOutline;
  if (entry.type === 'commit') return mdiSourceRepository;
  return KIND_ICONS[fileKind(entry.path)] ?? mdiFileOutline;
}

/** A short type label for the file list. */
export function entryType(entry: Pick<TreeEntry, 'type' | 'path'>): string {
  if (entry.type === 'tree') return 'Folder';
  if (entry.type === 'commit') return 'Submodule';
  const extension = extensionOf(entry.path);
  return extension ? extension.toUpperCase() : 'File';
}

export type Preview =
  'image' | 'video' | 'markdown' | 'text' | 'pdf' | 'binary' | 'tooLarge' | 'mediaTooLarge';

/**
 * How the viewer shows a file: images and videos inline through the raw route (up to its limit),
 * Markdown rendered, text highlighted; PDFs, other binaries and files past the viewer limit get a
 * download button instead.
 */
export function previewOf(file: FileContent): Preview {
  const kind = fileKind(file.path);
  if (kind === 'image' || kind === 'video') {
    return file.size > MAX_PREVIEW_BYTES ? 'mediaTooLarge' : kind;
  }
  if (kind === 'pdf') return 'pdf';
  if (file.binary) return 'binary';
  if (file.tooLarge || file.content === null) return 'tooLarge';
  return kind === 'markdown' ? 'markdown' : 'text';
}

/** One row of a side-by-side diff: the old line on the left, the new one on the right. */
export interface SideRow {
  kind: 'hunk' | 'note' | 'pair';
  text?: string;
  left: DiffLine | null;
  right: DiffLine | null;
}

/**
 * Pair the lines of a unified diff for a side-by-side view: context on both sides, a run of
 * deletions next to the run of additions that follows it, hunk headers and notes across.
 */
export function sideBySide(lines: DiffLine[]): SideRow[] {
  const rows: SideRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i += 1) {
      rows.push({ kind: 'pair', left: dels[i] ?? null, right: adds[i] ?? null });
    }
    dels = [];
    adds = [];
  };
  for (const line of lines) {
    if (line.kind === 'del') {
      if (adds.length > 0) flush();
      dels.push(line);
    } else if (line.kind === 'add') {
      adds.push(line);
    } else {
      flush();
      if (line.kind === 'context') rows.push({ kind: 'pair', left: line, right: line });
      else rows.push({ kind: line.kind, text: line.text, left: null, right: null });
    }
  }
  flush();
  return rows;
}

/** One visible row of the folder tree. */
export interface FolderRow {
  path: string;
  name: string;
  depth: number;
  open: boolean;
  /** False once the folder is known to have no subfolders. */
  expandable: boolean;
}

/**
 * The visible rows of the folder tree: the subfolders of every open folder, depth first.
 * `children` holds the subfolders of each folder loaded so far.
 */
export function folderRows(children: Map<string, string[]>, open: Set<string>): FolderRow[] {
  const rows: FolderRow[] = [];
  const walk = (dir: string, depth: number) => {
    for (const path of children.get(dir) ?? []) {
      const isOpen = open.has(path);
      const known = children.get(path);
      rows.push({
        path,
        name: path.slice(path.lastIndexOf('/') + 1),
        depth,
        open: isOpen,
        expandable: known === undefined || known.length > 0,
      });
      if (isOpen) walk(path, depth + 1);
    }
  };
  walk('', 0);
  return rows;
}

/** Every ancestor folder of `path`, outermost first, without the root. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}
