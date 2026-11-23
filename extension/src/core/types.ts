// Shared types. Core modules (src/core/*) must not import Node APIs: they are
// meant to run unchanged in a browser renderer (Roam extension).

export const F_TRIMMED = 1;        // link target had leading/trailing whitespace
export const F_ESCAPED_PIPE = 2;   // [[a\|b]] (table-escaped pipe)
export const F_RELATIVE = 4;       // ./ or ../ path in a markdown link
export const F_ABSOLUTE = 8;       // leading "/" in linkpath
export const F_DECODE_FAIL = 16;   // decodeURIComponent threw (e.g. literal "%")
export const F_UNQUOTED_YAML = 32; // [[link]] in frontmatter without quotes (YAML nested list)
export const F_HAS_MD_EXT = 64;    // linkpath ends with .md
export const F_EMPTY_ALIAS = 128;  // [[a|]]
export const F_ANGLE = 256;        // [x](<Target Name.md>)
export const F_OKF = 512;          // an OKF type or status value: a link only in an OKF bundle

export type LinkKind = 'wiki' | 'md' | 'prop';

export interface Link {
  kind: LinkKind;        // wikilink, markdown link, or frontmatter property link
  embed: boolean;        // ![[...]] / ![](...)
  target: string;        // linkpath: decoded, NFC, trimmed, without #subpath ('' = self)
  subpath: string;       // '' | '#Heading' | '#^blockid' | '#H1#H2'
  display: string | null;// alias / link text / embed size
  line: number;          // 0-based line in the file
  col: number;           // 0-based column (UTF-16 units)
  flags: number;         // F_* bitmask
  prop?: string;         // frontmatter key, for kind === 'prop'
  snippet?: string;      // optional short context (opts.snippets)
}

export interface Heading { level: number; text: string; line: number }

export interface ParsedNote {
  path: string;          // vault-relative, '/'-separated, NFC
  title: string;         // basename without .md
  aliases: string[];
  tags: string[];        // without '#', original case; frontmatter + inline
  links: Link[];
  headings: Heading[];
  blockIds: string[];
  props: Record<string, string | string[]> | null; // shallow frontmatter (lite parser)
  fmError: string | null;
  stats: { bytes: number; lines: number; deadRanges: number };
}

/** What the index keeps of a note. No text and no object per link: a large vault has
 *  hundreds of thousands of links, and this is what stays in memory for all of them. */
export interface Note {
  path: string;          // vault-relative, '/'-separated, NFC
  size: number;          // file size and modification time when it was parsed
  mtime: number;
  aliases: string[];
  tags: string[];        // without '#', original case; frontmatter + inline
  /** Flat pairs: link target ('' targets, which point at the note itself, are left out),
   *  then line * 2 + (1 for an embed), or -1 - line for a link that counts only when the note is in
   *  an OKF bundle (F_OKF). */
  links: (string | number)[];
  /** OKF: the frontmatter `title`, the note's name when it is in a bundle. */
  title?: string;
  /** OKF: an index.md whose frontmatter has okf_version, which makes its folder a bundle's root. */
  root?: true;
}

export interface ParseOptions {
  snippets?: boolean;    // store a ~100 char context string per link
}
