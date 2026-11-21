import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRefs, storageKey, collect, compare, formatSize, kindOf, type Row } from '../src/files.ts';

const U = (id: string, g = 'g') => `https://firebasestorage.googleapis.com/v0/b/firescript-577a2.appspot.com/o/imgs%2Fapp%2F${g}%2F${id}?alt=media&token=t-${id}`;

test('finds files in every form Roam writes', () => {
  const s = `![](${U('a.png')}) and {{[[pdf]]: ${U('b.pdf')}}} {{pdf: ${U('c.pdf')}}}\n{{[[audio]]: ${U('d.mp3')}}} [Report Q3.xlsx](${U('e.xlsx')}) <${U('f.txt')}>`;
  const r = findRefs(s);
  assert.deepEqual(r.map((x) => storageKey(x.url)), ['a.png', 'b.pdf', 'c.pdf', 'd.mp3', 'e.xlsx', 'f.txt'].map((f) => `imgs/app/g/${f}`));
  assert.deepEqual(r.map((x) => x.label), [null, null, null, null, 'Report Q3.xlsx', null]);
});

test('keeps encoded spaces and decodes the storage path', () => {
  const url = U('buk9okKVv0.06.37%20PM.png');
  assert.equal(findRefs(`![](${url})`)[0].url, url);
  assert.equal(storageKey(url), 'imgs/app/g/buk9okKVv0.06.37 PM.png');
});

test('an image in a label is not a label', () => {
  assert.equal(findRefs(`![alt](${U('a.png')})`)[0].label, null);
});

test('ignores other links', () => {
  assert.deepEqual(findRefs('see https://example.com/x.png and [a](https://roamresearch.com)'), []);
});

test('groups by storage path across tokens and blocks', () => {
  const files = collect([
    { uid: 'b1', text: `![](${U('a.png')})`, time: 200, pageUid: 'p1', pageTitle: 'One' },
    { uid: 'b2', text: `![](${U('a.png').replace('t-a.png', 'other')}) ![](${U('a.png')})`, time: 100, pageUid: 'p2', pageTitle: 'Two' },
    { uid: 'b3', text: `[notes.txt](${U('XyZ1234567notes.txt')})`, time: 300, pageUid: 'p2', pageTitle: 'Two' },
  ]);
  assert.equal(files.size, 2);
  const a = files.get('imgs/app/g/a.png')!;
  assert.equal(a.added, 100);
  assert.deepEqual(a.uses.map((u) => u.uid), ['b1', 'b2']);
  assert.equal(a.kind, 'image');
  assert.equal(files.get('imgs/app/g/XyZ1234567notes.txt')!.name, 'notes.txt');
});

test('kinds', () => {
  assert.equal(kindOf('jpeg'), 'image');
  assert.equal(kindOf('pdf'), 'pdf');
  assert.equal(kindOf('m4a'), 'audio');
  assert.equal(kindOf('mov'), 'video');
  assert.equal(kindOf('zip'), 'other');
});

test('sorts by date, newest first, and by size with unknown sizes last', () => {
  const row = (key: string, added: number, size: number | null): Row => ({ key, url: '', name: key, ext: 'png', kind: 'image', added, uses: [], size, unused: false, lastUsed: 0 });
  const rows = [row('a', 1, 10), row('b', 3, null), row('c', 2, 30)];
  assert.deepEqual([...rows].sort(compare('added', true)).map((r) => r.key), ['b', 'c', 'a']);
  assert.deepEqual([...rows].sort(compare('size', true)).map((r) => r.key), ['c', 'a', 'b']);
});

test('sizes', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatSize(null), '');
});
