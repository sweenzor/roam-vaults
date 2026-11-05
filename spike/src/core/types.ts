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

export interface ParseOptions {
  snippets?: boolean;    // store a ~100 char context string per link
}
