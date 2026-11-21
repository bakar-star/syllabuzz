/* Syllabuzz document reader.
   Turns PDF, Word (.docx), PowerPoint (.pptx), OpenDocument (.odt/.odp), RTF, HTML, CSV and plain
   text files into clean Markdown, entirely on the device. Nothing is uploaded anywhere.

     DocReader.read(file | {bytes, name, mime}, {onProgress}) -> {name, text, kind, pages, warnings}
     DocReader.ACCEPT   -> value for <input accept>

   Word, PowerPoint and OpenDocument files are ZIP packages of XML, read here with the browser's own
   DecompressionStream, so they need no library at all. PDFs use the bundled pdf.js (vendor/), loaded
   from the app itself, then from the page's own folder, then from a CDN as a last resort. */
(function () {
  'use strict';

  var ACCEPT = '.pdf,.docx,.pptx,.odt,.odp,.rtf,.html,.htm,.txt,.md,.markdown,.csv,.tsv,.text,' +
    'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
    'application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/markdown';
  var MAX_PDF_PAGES = 600;

  function fail(msg, code) { var e = new Error(msg); e.code = code || 'read'; return e; }
  function tick() { return new Promise(function (r) { setTimeout(r, 0) }); }

  /* ---------------------------------------------------------------- text decoding */
  function decodeText(u8) {
    if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return new TextDecoder('utf-8').decode(u8.subarray(3));
    if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8.subarray(2));
    if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8.subarray(2));
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8) }
    catch (e) { return new TextDecoder('windows-1252').decode(u8) }
  }
  function joinLists(t) {
    var blocks = String(t).split(/\n{2,}/), out = [], mk = /^\s*(?:-|\d+\.)\s/;
    blocks.forEach(function (b) {
      var prev = out.length ? out[out.length - 1] : '';
      if (mk.test(b) && prev && mk.test(prev.split('\n').pop())) out[out.length - 1] = prev + '\n' + b; else out.push(b);
    });
    return out.join('\n\n');
  }
  function tidy(s) {
    return String(s).replace(/\r\n?/g, '\n').replace(/ /g, ' ').replace(/[​‌‍﻿­]/g, '')
      .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function sniff(u8, name) {
    var n = String(name || '').toLowerCase();
    if (u8.length > 4 && u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46) return 'pdf';
    if (u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4B) {            /* a ZIP package: look at its extension */
      if (/\.docx?$/.test(n) || /\.dotx$/.test(n)) return 'docx';
      if (/\.pptx?$/.test(n) || /\.ppsx$/.test(n)) return 'pptx';
      if (/\.odt$/.test(n)) return 'odt';
      if (/\.odp$/.test(n)) return 'odp';
      return 'zip';
    }
    if (u8.length > 8 && u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0) return 'legacy';
    if (/\.pdf$/.test(n)) return 'pdf';
    if (/\.rtf$/.test(n) || (u8[0] === 0x7B && u8[1] === 0x5C && u8[2] === 0x72 && u8[3] === 0x74)) return 'rtf';
    if (/\.html?$/.test(n)) return 'html';
    if (/\.(csv|tsv)$/.test(n)) return /\.tsv$/.test(n) ? 'tsv' : 'csv';
    return 'text';
  }

  /* ---------------------------------------------------------------- ZIP reader */
  function u16(b, o) { return b[o] | (b[o + 1] << 8) }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 }
  async function inflateRaw(u8) {
    if (typeof DecompressionStream === 'undefined') throw fail('This device cannot open Word or PowerPoint files (its web view is too old). Update Android System WebView, or save the file as PDF.', 'nodecomp');
    var stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  function openZip(u8) {
    var end = -1, i, min = Math.max(0, u8.length - 65557);
    for (i = u8.length - 22; i >= min; i--) { if (u8[i] === 0x50 && u8[i + 1] === 0x4B && u8[i + 2] === 5 && u8[i + 3] === 6) { end = i; break } }
    if (end < 0) throw fail('That file is damaged (it is not a complete Office file).', 'zip');
    var count = u16(u8, end + 10), off = u32(u8, end + 16), entries = {}, dec = new TextDecoder('utf-8');
    for (i = 0; i < count; i++) {
      if (u32(u8, off) !== 0x02014b50) break;
      var flags = u16(u8, off + 8), method = u16(u8, off + 10), csize = u32(u8, off + 20), usize = u32(u8, off + 24),
        nl = u16(u8, off + 28), el = u16(u8, off + 30), cl = u16(u8, off + 32), lho = u32(u8, off + 42),
        name = dec.decode(u8.subarray(off + 46, off + 46 + nl));
      entries[name] = { method: method, csize: csize, usize: usize, lho: lho, enc: flags & 1 };
      off += 46 + nl + el + cl;
    }
    var api = {
      names: Object.keys(entries),
      has: function (n) { return !!entries[n] },
      bytes: async function (n) {
        var e = entries[n]; if (!e) return null;
        if (e.enc) throw fail('This file is password protected. Remove the password and try again.', 'locked');
        var p = e.lho; if (u32(u8, p) !== 0x04034b50) throw fail('That file is damaged.', 'zip');
        var start = p + 30 + u16(u8, p + 26) + u16(u8, p + 28), raw = u8.subarray(start, start + e.csize);
        return e.method === 0 ? raw : await inflateRaw(raw);
      },
      text: async function (n) { var b = await api.bytes(n); return b ? dec.decode(b) : null }
    };
    return api;
  }

  /* ---------------------------------------------------------------- XML helpers */
  function xml(str) {
    var d = new DOMParser().parseFromString(str, 'application/xml');
    if (d.getElementsByTagName('parsererror').length) throw fail('Part of that file could not be understood.', 'xml');
    return d;
  }
  function kids(n) { var o = [], c = n && n.firstElementChild; while (c) { o.push(c); c = c.nextElementSibling } return o }
  function ln(n) { return n.localName }
  function kid(n, name) { var c = n && n.firstElementChild; while (c) { if (c.localName === name) return c; c = c.nextElementSibling } return null }
  function attr(n, name) { return n ? (n.getAttribute(name) || n.getAttribute('w:' + name) || n.getAttribute('a:' + name) || '') : '' }
  function esc(s) { return String(s).replace(/([\\`*_{}\[\]<>|])/g, '\\$1') }
  function cleanCell(s) { return String(s).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim() }
  function mdTable(rows) {
    rows = rows.filter(function (r) { return r.some(function (c) { return String(c).trim() }) });
    if (!rows.length) return '';
    var w = 0; rows.forEach(function (r) { w = Math.max(w, r.length) });
    var pad = function (r) { r = r.slice(); while (r.length < w) r.push(''); return r.map(cleanCell) };
    var out = ['| ' + pad(rows[0]).join(' | ') + ' |', '| ' + pad(rows[0]).map(function () { return '---' }).join(' | ') + ' |'];
    for (var i = 1; i < rows.length; i++) out.push('| ' + pad(rows[i]).join(' | ') + ' |');
    return out.join('\n');
  }
  /* merge runs that carry the same bold/italic so the Markdown has no `**a****b**` noise */
  function fmtRuns(runs) {
    var out = '', cur = null, buf = '';
    function flush() {
      if (!buf) return;
      var lead = buf.match(/^\s*/)[0], trail = buf.match(/\s*$/)[0], core = buf.trim();
      if (!core) { out += buf; buf = ''; return }
      var t = esc(core);
      if (cur && cur.b && cur.i) t = '***' + t + '***'; else if (cur && cur.b) t = '**' + t + '**'; else if (cur && cur.i) t = '*' + t + '*';
      out += lead + t + trail; buf = '';
    }
    runs.forEach(function (r) {
      if (!cur || cur.b !== r.b || cur.i !== r.i) { flush(); cur = { b: r.b, i: r.i } }
      buf += r.t;
    });
    flush();
    return out;
  }

  /* ---------------------------------------------------------------- DOCX */
  async function readDocx(zip, warn) {
    var docXml = await zip.text('word/document.xml');
    if (!docXml) throw fail('That does not look like a Word document.', 'format');
    var doc = xml(docXml), styles = {}, nums = {}, abs = {};
    var st = await zip.text('word/styles.xml');
    if (st) kids(xml(st).documentElement).forEach(function (s) {
      if (ln(s) !== 'style') return;
      var id = attr(s, 'styleId'), nm = attr(kid(s, 'name'), 'val'), bo = attr(kid(s, 'basedOn'), 'val'),
        pPr = kid(s, 'pPr'), ol = pPr && kid(pPr, 'outlineLvl');
      styles[id] = { name: nm.toLowerCase(), based: bo, outline: ol ? +attr(ol, 'val') : null };
    });
    var nm = await zip.text('word/numbering.xml');
    if (nm) {
      var nd = xml(nm).documentElement;
      kids(nd).forEach(function (n) {
        if (ln(n) === 'abstractNum') {
          var lv = {}; kids(n).forEach(function (l) { if (ln(l) === 'lvl') lv[attr(l, 'ilvl')] = attr(kid(l, 'numFmt'), 'val') });
          abs[attr(n, 'abstractNumId')] = lv;
        }
      });
      kids(nd).forEach(function (n) { if (ln(n) === 'num') nums[attr(n, 'numId')] = attr(kid(n, 'abstractNumId'), 'val') });
    }
    function headingLevel(sid, pPr) {
      var seen = 0, id = sid;
      while (id && styles[id] && seen++ < 8) {
        var s = styles[id], m = /^heading\s*(\d)$/.exec(s.name) || /^heading(\d)$/i.exec(id);
        if (m) return Math.min(6, +m[1]);
        if (s.name === 'title') return 1;
        if (s.name === 'subtitle') return 2;
        if (s.outline != null && s.outline < 6) return s.outline + 1;
        id = s.based;
      }
      var ol = pPr && kid(pPr, 'outlineLvl'); if (ol && +attr(ol, 'val') < 6) return +attr(ol, 'val') + 1;
      return 0;
    }
    var counters = {};
    function boolOn(el) { if (!el) return false; var v = attr(el, 'val'); return v !== '0' && v !== 'false' && v !== 'none' }
    function collectRuns(p, runs) {
      kids(p).forEach(function (c) {
        var n = ln(c);
        if (n === 'r') {
          var rPr = kid(c, 'rPr'), b = rPr && boolOn(kid(rPr, 'b')), it = rPr && boolOn(kid(rPr, 'i')), t = '';
          kids(c).forEach(function (x) {
            var xn = ln(x);
            if (xn === 't') t += x.textContent;
            else if (xn === 'tab') t += ' ';
            else if (xn === 'br' || xn === 'cr') { if (attr(x, 'type') !== 'page') t += '\n' }
            else if (xn === 'noBreakHyphen') t += '-';
            else if (xn === 'softHyphen') t += '';
          });
          if (t) runs.push({ t: t, b: !!b, i: !!it });
        } else if (n === 'hyperlink' || n === 'smartTag' || n === 'ins' || n === 'fldSimple' || n === 'sdt' || n === 'sdtContent' || n === 'customXml') collectRuns(c, runs);
      });
    }
    function paraText(p) { var runs = []; collectRuns(p, runs); return runs }
    function table(tbl) {
      var rows = [];
      kids(tbl).forEach(function (tr) {
        if (ln(tr) !== 'tr') return;
        var cells = [];
        kids(tr).forEach(function (tc) {
          if (ln(tc) !== 'tc') return;
          var parts = []; kids(tc).forEach(function (p) { if (ln(p) === 'p') { var t = fmtRuns(paraText(p)).trim(); if (t) parts.push(t) } });
          cells.push(parts.join(' '));
          var span = kid(kid(tc, 'tcPr'), 'gridSpan'); if (span) for (var k = 1; k < +attr(span, 'val'); k++) cells.push('');
        });
        rows.push(cells);
      });
      return mdTable(rows);
    }
    var out = [], body = kid(doc.documentElement, 'body'), lastList = false;
    function walk(parent) {
      kids(parent).forEach(function (n) {
        var name = ln(n);
        if (name === 'p') {
          var pPr = kid(n, 'pPr'), sid = pPr ? attr(kid(pPr, 'pStyle'), 'val') : '', runs = paraText(n);
          var text = runs.length ? fmtRuns(runs).replace(/\n+/g, '  \n').trim() : '', lvl = headingLevel(sid, pPr);
          if (!text) { lastList = false; return }
          var numPr = pPr && kid(pPr, 'numPr'), ls = sid && styles[sid] && /list/.test(styles[sid].name);
          if (lvl) { out.push('#'.repeat(lvl) + ' ' + text.replace(/^\*+|\*+$/g, '').replace(/\s*\n\s*/g, ' ')); lastList = false; return }
          if (numPr || ls) {
            var il = numPr ? +attr(kid(numPr, 'ilvl'), 'val') || 0 : 0, nid = numPr ? attr(kid(numPr, 'numId'), 'val') : '', fmt = (abs[nums[nid]] || {})[il] || 'bullet', mark;
            if (nid === '0') { out.push(text); lastList = false; return }
            if (fmt === 'bullet' || fmt === 'none' || !fmt) mark = '-';
            else { var ck = nid + ':' + il; counters[ck] = (counters[ck] || 0) + 1; for (var d = il + 1; d < 9; d++) delete counters[nid + ':' + d]; mark = counters[ck] + '.' }
            var line = '  '.repeat(il) + mark + ' ' + text.replace(/\s*\n\s*/g, ' ');
            if (lastList && out.length) out[out.length - 1] += '\n' + line; else out.push(line);
            lastList = true; return;
          }
          out.push(text); lastList = false;
        } else if (name === 'tbl') { var t = table(n); if (t) out.push(t); lastList = false }
        else if (name === 'sdt' || name === 'sdtContent' || name === 'customXml') walk(n);
      });
    }
    walk(body);
    var fn = await zip.text('word/footnotes.xml');
    if (fn) {
      var notes = [];
      kids(xml(fn).documentElement).forEach(function (f) {
        var id = +attr(f, 'id'); if (!(id > 0)) return;
        var t = []; kids(f).forEach(function (p) { if (ln(p) === 'p') t.push(fmtRuns(paraText(p)).trim()) });
        var s = t.join(' ').trim(); if (s) notes.push('[^' + id + ']: ' + s);
      });
      if (notes.length) { warn.push('Footnotes were added at the end.'); out.push('---\n\n' + notes.join('\n')) }
    }
    var text = out.join('\n\n');
    if (!text.trim()) warn.push('No text found. The document may contain only images.');
    var title = ''; try { var core = await zip.text('docProps/core.xml'); if (core) { var m = /<dc:title[^>]*>([^<]*)</.exec(core); if (m) title = m[1].trim() } } catch (e) {}
    return { text: text, title: title };
  }

  /* ---------------------------------------------------------------- PPTX */
  async function readPptx(zip, warn) {
    var pres = await zip.text('ppt/presentation.xml');
    if (!pres) throw fail('That does not look like a PowerPoint file.', 'format');
    var order = [], rels = {}, rx = await zip.text('ppt/_rels/presentation.xml.rels');
    if (rx) kids(xml(rx).documentElement).forEach(function (r) { rels[attr(r, 'Id')] = attr(r, 'Target') });
    var lst = kid(xml(pres).documentElement, 'sldIdLst');
    if (lst) kids(lst).forEach(function (s) {
      var rid = s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      var tg = rels[rid]; if (tg) order.push('ppt/' + tg.replace(/^\/?(ppt\/)?/, ''));
    });
    if (!order.length) order = zip.names.filter(function (n) { return /^ppt\/slides\/slide\d+\.xml$/.test(n) }).sort(function (a, b) { return parseInt(a.match(/(\d+)\.xml/)[1], 10) - parseInt(b.match(/(\d+)\.xml/)[1], 10) });
    function runText(p) {
      var s = '';
      kids(p).forEach(function (c) {
        var n = ln(c);
        if (n === 'r') { var t = kid(c, 't'); if (t) s += t.textContent }
        else if (n === 'br') s += ' ';
        else if (n === 'fld') { if (!/slidenum|datetime/i.test(attr(c, 'type'))) { var t2 = kid(c, 't'); if (t2) s += t2.textContent } }
      });
      return s.replace(/\s+/g, ' ').trim();
    }
    function runsOf(p) {
      var runs = [];
      kids(p).forEach(function (c) {
        if (ln(c) === 'r') {
          var rPr = kid(c, 'rPr'), t = kid(c, 't'); if (!t) return;
          runs.push({ t: t.textContent, b: !!(rPr && rPr.getAttribute('b') === '1'), i: !!(rPr && rPr.getAttribute('i') === '1') });
        } else if (ln(c) === 'br') runs.push({ t: ' ', b: false, i: false });
      });
      return fmtRuns(runs).replace(/\s+/g, ' ').trim();
    }
    function shapes(tree, acc) {
      kids(tree).forEach(function (n) {
        var name = ln(n);
        if (name === 'sp') acc.push(n);
        else if (name === 'grpSp') shapes(n, acc);
        else if (name === 'graphicFrame') acc.push(n);
        else if (name === 'AlternateContent') { var ch = kid(n, 'Choice') || kid(n, 'Fallback'); if (ch) shapes(ch, acc) }
      });
      return acc;
    }
    function phType(sp) {
      var nv = kid(sp, 'nvSpPr'), nvp = nv && kid(nv, 'nvPr'), ph = nvp && kid(nvp, 'ph');
      return ph ? (attr(ph, 'type') || 'body') : '';
    }
    function bodyLines(sp, isBody) {
      var tx = kid(sp, 'txBody'), out = []; if (!tx) return out;
      kids(tx).forEach(function (p) {
        if (ln(p) !== 'p') return;
        var t = runsOf(p); if (!t) return;
        var pPr = kid(p, 'pPr'), lvl = pPr ? +pPr.getAttribute('lvl') || 0 : 0,
          none = pPr && kid(pPr, 'buNone'), has = pPr && (kid(pPr, 'buChar') || kid(pPr, 'buAutoNum'));
        var num = pPr && kid(pPr, 'buAutoNum');
        if (has || (isBody && !none)) out.push('  '.repeat(lvl) + (num ? '1. ' : '- ') + t); else out.push(t);
      });
      return out;
    }
    function tableOf(gf) {
      var tbl = null;
      (function find(n) { kids(n).forEach(function (c) { if (!tbl && ln(c) === 'tbl') tbl = c; else if (!tbl) find(c) }) })(gf);
      if (!tbl) return '';
      var rows = [];
      kids(tbl).forEach(function (tr) {
        if (ln(tr) !== 'tr') return;
        var cells = []; kids(tr).forEach(function (tc) {
          if (ln(tc) !== 'tc') return;
          var tx = kid(tc, 'txBody'), parts = []; if (tx) kids(tx).forEach(function (p) { if (ln(p) === 'p') { var t = runText(p); if (t) parts.push(t) } });
          cells.push(parts.join(' '));
        });
        rows.push(cells);
      });
      return mdTable(rows);
    }
    var out = [], firstTitle = '';
    for (var i = 0; i < order.length; i++) {
      var path = order[i], sx = await zip.text(path); if (!sx) continue;
      var root = xml(sx).documentElement, tree = kid(kid(root, 'cSld'), 'spTree'), list = tree ? shapes(tree, []) : [];
      var title = '', parts = [];
      list.forEach(function (n) {
        if (ln(n) === 'graphicFrame') { var t = tableOf(n); if (t) parts.push(t); return }
        var ph = phType(n);
        if (/^(sldNum|dt|ftr|hdr)$/.test(ph)) return;
        if (/^(title|ctrTitle)$/.test(ph)) { var tl = bodyLines(n, false).join(' '); if (tl && !title) title = tl; return }
        var lines = bodyLines(n, ph === 'body' || ph === 'subTitle' || ph === 'obj' || ph === '');
        if (ph === 'subTitle') lines = lines.map(function (l) { return l.replace(/^-\s+/, '') });
        if (lines.length) parts.push(lines.join('\n'));
      });
      var notes = '', rp = path.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels'), rl = await zip.text(rp);
      if (rl) {
        var nt = null; kids(xml(rl).documentElement).forEach(function (r) { if (/notesSlide/.test(attr(r, 'Type'))) nt = attr(r, 'Target') });
        if (nt) {
          var np = 'ppt/' + nt.replace(/^(\.\.\/)+/, '').replace(/^\/?(ppt\/)?/, ''), nx = await zip.text(np);
          if (nx) {
            var nl = []; var ntree = kid(kid(xml(nx).documentElement, 'cSld'), 'spTree');
            if (ntree) shapes(ntree, []).forEach(function (sp) { if (ln(sp) === 'sp' && phType(sp) === 'body') bodyLines(sp, false).forEach(function (l) { nl.push(l) }) });
            notes = nl.join(' ').trim();
          }
        }
      }
      if (!firstTitle && title) firstTitle = title;
      var head = '## Slide ' + (i + 1) + (title ? ': ' + title : '');
      var block = head + (parts.length ? '\n\n' + parts.join('\n\n') : '') + (notes ? '\n\n> Speaker notes\n>\n> ' + notes : '');
      out.push(block);
    }
    if (!out.length) throw fail('No slides were found in that file.', 'format');
    var text = out.join('\n\n');
    if (!/[A-Za-z0-9À-￿]/.test(text.replace(/## Slide \d+/g, ''))) warn.push('The slides contain no text (only pictures).');
    var title2 = firstTitle; try { var core = await zip.text('docProps/core.xml'); if (core) { var m = /<dc:title[^>]*>([^<]*)</.exec(core); if (m && m[1].trim()) title2 = m[1].trim() } } catch (e) {}
    return { text: text, title: title2, pages: out.length };
  }

  /* ---------------------------------------------------------------- ODT / ODP */
  async function readOdf(zip, kind, warn) {
    var cx = await zip.text('content.xml'); if (!cx) throw fail('That does not look like an OpenDocument file.', 'format');
    var root = xml(cx).documentElement, out = [], slide = 0, skipNode = null;
    function inline(n) {
      var s = '';
      (function go(x) {
        x.childNodes.forEach(function (c) {
          if (c.nodeType === 3) s += c.nodeValue;
          else if (c.nodeType === 1) {
            var nm = c.localName;
            if (nm === 's') s += ' '.repeat(+c.getAttribute('text:c') || 1);
            else if (nm === 'tab') s += ' ';
            else if (nm === 'line-break') s += ' ';
            else if (nm === 'note') return;
            else go(c);
          }
        });
      })(n);
      return s.replace(/\s+/g, ' ').trim();
    }
    function table(t) {
      var rows = [];
      (function go(x) { kids(x).forEach(function (c) {
        if (ln(c) === 'table-row') { var cells = []; kids(c).forEach(function (tc) { if (ln(tc) === 'table-cell') cells.push(inline(tc)) }); rows.push(cells) }
        else if (/^table-(rows|header-rows)$/.test(ln(c))) go(c);
      }) })(t);
      return mdTable(rows);
    }
    function walk(n, depth) {
      kids(n).forEach(function (c) {
        var nm = ln(c);
        if (c === skipNode) return;
        if (nm === 'h') { var t = inline(c); if (t) out.push('#'.repeat(Math.min(6, +c.getAttribute('text:outline-level') || 1)) + ' ' + t) }
        else if (nm === 'p') { var tp = inline(c); if (tp) out.push(depth ? '  '.repeat(depth - 1) + '- ' + tp : tp) }
        else if (nm === 'list') walk(c, depth + 1);
        else if (nm === 'list-item' || nm === 'list-header') walk(c, depth);
        else if (nm === 'table') { var tb = table(c); if (tb) out.push(tb) }
        else if (nm === 'page') {
          slide++; var ttl = '', fr = c.getElementsByTagName('*'), q;
          for (q = 0; q < fr.length; q++) { if (fr[q].localName === 'frame' && fr[q].getAttribute('presentation:class') === 'title') { ttl = inline(fr[q]); skipNode = fr[q]; break } }
          out.push('## Slide ' + slide + (ttl ? ': ' + ttl : '')); walk(c, 0)
        }
        else if (/^(frame|text-box|section|body|text|presentation|spreadsheet|drawing|custom-shape)$/.test(nm)) walk(c, depth);
      });
    }
    walk(root, 0);
    var text = out.join('\n\n');
    if (!text.trim()) warn.push('No text found in that file.');
    return { text: text, pages: slide || undefined };
  }

  /* ---------------------------------------------------------------- RTF / HTML / CSV */
  function readRtf(u8) {
    var s = new TextDecoder('windows-1252').decode(u8), out = '', i = 0, depth = 0, skip = 0, stack = [], uc = 1;
    var skipDest = /^(fonttbl|colortbl|stylesheet|info|pict|header|footer|footnote|\*|object|themedata|colorschememapping|latentstyles|datastore|listtable|listoverridetable|rsidtbl|generator)$/;
    while (i < s.length) {
      var ch = s[i];
      if (ch === '{') { stack.push(skip); depth++; i++; var m0 = /^\\\*?\\?([a-z]+)/.exec(s.substr(i, 24)); if (s[i] === '\\' && s[i + 1] === '*') skip = skip || 1; else if (m0 && skipDest.test(m0[1])) skip = skip || 1; continue }
      if (ch === '}') { skip = stack.pop() || 0; depth--; i++; continue }
      if (ch === '\\') {
        var nx = s[i + 1];
        if (nx === '\\' || nx === '{' || nx === '}') { if (!skip) out += nx; i += 2; continue }
        if (nx === "'") { if (!skip) out += String.fromCharCode(parseInt(s.substr(i + 2, 2), 16)); i += 4; continue }
        if (nx === '~') { if (!skip) out += ' '; i += 2; continue }
        if (nx === '-' || nx === '_') { if (!skip && nx === '_') out += '-'; i += 2; continue }
        var m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(s.substr(i, 40));
        if (m) {
          var w = m[1], n = m[2] != null ? +m[2] : null;
          if (!skip) {
            if (w === 'par' || w === 'line' || w === 'sect' || w === 'page') out += '\n';
            else if (w === 'tab') out += ' ';
            else if (w === 'cell') out += ' | ';
            else if (w === 'row') out += '\n';
            else if (w === 'bullet') out += '• ';
            else if (w === 'emdash') out += '—'; else if (w === 'endash') out += '–';
            else if (w === 'lquote') out += '‘'; else if (w === 'rquote') out += '’';
            else if (w === 'ldblquote') out += '“'; else if (w === 'rdblquote') out += '”';
            else if (w === 'u' && n != null) { out += String.fromCharCode(n < 0 ? n + 65536 : n); i += m[0].length; var k = uc; while (k-- > 0 && s[i]) { if (s[i] === '\\' && s[i + 1] === "'") i += 4; else if (s[i] === '\\' || s[i] === '{' || s[i] === '}') break; else i++ } continue }
          }
          if (w === 'uc' && n != null) uc = n;
          i += m[0].length; continue;
        }
        i++; continue;
      }
      if (!skip && ch !== '\n' && ch !== '\r') out += ch;
      i++;
    }
    return out.replace(/^[ \t]*[·•\uF0B7\uF0A7\uF0D8?]\s+/gm, '- ').replace(/ \| \n/g, '\n').replace(/^ \| /gm, '');
  }
  function readHtml(str) {
    var d = new DOMParser().parseFromString(str, 'text/html'), out = [];
    d.querySelectorAll('script,style,noscript,svg,nav,footer,iframe').forEach(function (n) { n.remove() });
    (function walk(n, depth) {
      Array.prototype.forEach.call(n.children, function (c) {
        var t = c.tagName.toLowerCase(), tx = c.textContent.replace(/\s+/g, ' ').trim();
        if (/^h[1-6]$/.test(t)) { if (tx) out.push('#'.repeat(+t[1]) + ' ' + tx) }
        else if (t === 'p' || t === 'blockquote' || t === 'pre') { if (tx) out.push(t === 'blockquote' ? '> ' + tx : tx) }
        else if (t === 'li') { var own = Array.prototype.filter.call(c.childNodes, function (x) { return x.nodeType === 3 || !/^(ul|ol)$/i.test(x.tagName || '') }).map(function (x) { return x.textContent }).join('').replace(/\s+/g, ' ').trim(); if (own) out.push('  '.repeat(depth) + '- ' + own); Array.prototype.forEach.call(c.querySelectorAll(':scope > ul,:scope > ol'), function (l) { walk(l, depth + 1) }) }
        else if (t === 'ul' || t === 'ol') walk(c, depth);
        else if (t === 'table') { var rows = []; c.querySelectorAll('tr').forEach(function (tr) { rows.push(Array.prototype.map.call(tr.children, function (x) { return x.textContent })) }); var tb = mdTable(rows); if (tb) out.push(tb) }
        else walk(c, depth);
      });
    })(d.body || d.documentElement, 0);
    return out.join('\n\n');
  }
  function readCsv(str, sep) {
    var rows = [], row = [], cell = '', q = false, i, c;
    for (i = 0; i < str.length; i++) {
      c = str[i];
      if (q) { if (c === '"') { if (str[i + 1] === '"') { cell += '"'; i++ } else q = false } else cell += c }
      else if (c === '"') q = true;
      else if (c === sep) { row.push(cell); cell = '' }
      else if (c === '\n' || c === '\r') { if (c === '\r' && str[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = '' }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row) }
    return mdTable(rows);
  }

  /* ---------------------------------------------------------------- PDF */
  var pdfLib = null;
  function b64ToBytes(b64) {
    var bin = atob(b64), u8 = new Uint8Array(bin.length), i; for (i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8;
  }
  async function loadPdfJs() {
    if (pdfLib) return pdfLib;
    var errors = [], tries = [];
    /* 1) inside the Android app: the library is shipped with the app and handed over by the bridge */
    if (window.AndroidBridge && typeof AndroidBridge.readAsset === 'function') tries.push(async function () {
      var lib = AndroidBridge.readAsset('vendor/pdf.min.mjs'), wk = AndroidBridge.readAsset('vendor/pdf.worker.min.mjs');
      if (!lib || !wk) throw new Error('bundled PDF reader is missing');
      var url = URL.createObjectURL(new Blob([b64ToBytes(lib)], { type: 'text/javascript' })),
        wurl = URL.createObjectURL(new Blob([b64ToBytes(wk)], { type: 'text/javascript' }));
      var m = await import(url); m.GlobalWorkerOptions.workerSrc = wurl; return m;
    });
    /* 2) on the web: the vendor folder next to the page */
    if (location.protocol !== 'file:') tries.push(async function () {
      var base = new URL('vendor/', location.href).href, m = await import(base + 'pdf.min.mjs'); m.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs'; return m;
    });
    /* 3) last resort: a public CDN (needs internet) */
    tries.push(async function () {
      var base = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/', m = await import(base + 'pdf.min.mjs'); m.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs'; return m;
    });
    for (var i = 0; i < tries.length; i++) {
      try { pdfLib = await tries[i](); return pdfLib } catch (e) { errors.push(e && e.message) }
    }
    throw fail('The PDF reader could not be loaded (' + errors.filter(Boolean).join('; ') + ').', 'nopdf');
  }
  function median(a) { if (!a.length) return 0; a = a.slice().sort(function (x, y) { return x - y }); return a[a.length >> 1] }
  var BULLET = /^[•●○◦▪■□▫‣∙·▸►➢✓✔➤–—-]\s+/;
  async function readPdf(u8, opts, warn) {
    var lib = await loadPdfJs(), task, pdf;
    try {
      task = lib.getDocument({ data: u8.slice(), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
      pdf = await task.promise;
    } catch (e) {
      if (e && e.name === 'PasswordException') throw fail('This PDF is password protected. Remove the password and try again.', 'locked');
      throw fail('That PDF could not be opened (' + (e && e.message || 'damaged file') + ').', 'pdf');
    }
    var n = Math.min(pdf.numPages, MAX_PDF_PAGES), pages = [], allSizes = [], p;
    if (pdf.numPages > MAX_PDF_PAGES) warn.push('Only the first ' + MAX_PDF_PAGES + ' of ' + pdf.numPages + ' pages were read.');
    for (p = 1; p <= n; p++) {
      if (opts.onProgress) opts.onProgress('Reading page ' + p + ' of ' + n + '…');
      var page = await pdf.getPage(p), tc = await page.getTextContent(), lines = [], cur = null, prev = null;
      tc.items.forEach(function (it) {
        if (typeof it.str !== 'string') return;
        var t = it.transform, size = Math.abs(it.height) || Math.hypot(t[0], t[1]) || 10, x = t[4], y = t[5];
        if (!it.str.trim() && !it.hasEOL) { if (cur && it.str) { cur.t += (it.width || 0) > size * 1.0 ? '\u0001' : ' '; cur.end = x + (it.width || 0) } return }
        var newLine = !cur || Math.abs(y - cur.y) > Math.max(2, Math.min(cur.size, size) * 0.45) || x < cur.start - size * 3 && Math.abs(y - cur.y) > 1;
        if (newLine) { cur = { t: '', x: x, y: y, size: size, start: x, end: x, chars: 0 }; lines.push(cur) }
        else {
          var gap = x - cur.end;
          if (gap > size * 0.2 && !/\s$/.test(cur.t) && !/^\s/.test(it.str)) cur.t += gap > size * 1.0 ? '\u0001' : ' ';
        }
        cur.t += it.str; cur.end = x + (it.width || 0); cur.size = Math.max(cur.size, size) * (cur.chars ? 1 : 1); cur.chars += it.str.length;
        if (it.hasEOL) cur = null;
      });
      lines = lines.map(function (l) {
        var segs = l.t.split('\u0001').map(function (x) { return x.replace(/[\s\u0001]+/g, ' ').trim() }).filter(Boolean);
        l.cols = segs; l.t = segs.join(' ').replace(/^[\uE000-\uF8FF]+\s*/, '\u2022 ').replace(/[\uE000-\uF8FF]/g, '').trim(); return l;
      }).filter(function (l) { return l.t });
      lines.forEach(function (l) { for (var k = 0; k < Math.min(l.chars, 200); k += 20) allSizes.push(Math.round(l.size * 2) / 2) });
      var vw = page.view || [0, 0, 595, 842];
      pages.push({ lines: lines, h: (vw[3] - vw[1]) || 842, y0: vw[1] || 0 });
      if (p % 4 === 0) await tick();
    }
    var chars = 0; pages.forEach(function (pg) { pg.lines.forEach(function (l) { chars += l.t.length }) });
    if (chars < 20 * Math.max(1, n)) {
      throw fail('No text found in this PDF. It looks like a scan (pictures of pages). Scanned PDFs need text recognition (OCR), which is not built in yet. Try a text version of the file.', 'scan');
    }
    /* drop running headers, footers and page numbers: the same text at the edge of many pages */
    /* only text in the top or bottom strip of the page can be a running header or footer */
    var rim = function (pg, l) { var f = (l.y - pg.y0) / pg.h; return f > 0.9 || f < 0.1 };
    var norm = function (s) { return s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim() }, freq = {};
    pages.forEach(function (pg) {
      var seen = {}; pg.lines.filter(function (l) { return rim(pg, l) }).forEach(function (l) { var k = norm(l.t); if (k && !seen[k]) { seen[k] = 1; freq[k] = (freq[k] || 0) + 1 } });
    });
    var need = Math.max(3, Math.ceil(pages.length * 0.5)), isNum = /^(page\s*)?[-–]?\s*\d{1,4}\s*[-–]?(\s*(of|\/)\s*\d{1,4})?$/i;
    pages.forEach(function (pg) {
      pg.lines = pg.lines.filter(function (l) { return !(rim(pg, l) && (isNum.test(l.t) || (pages.length >= 3 && freq[norm(l.t)] >= need && l.t.length < 90))) });
    });
    /* heading sizes */
    var counts = {}; allSizes.forEach(function (s) { counts[s] = (counts[s] || 0) + 1 });
    var body = 0, best = 0; Object.keys(counts).forEach(function (k) { if (counts[k] > best) { best = counts[k]; body = +k } });
    var big = Object.keys(counts).map(Number).filter(function (s) { return s >= body * 1.18 && counts[s] >= 1 }).sort(function (a, b) { return b - a }).slice(0, 3);
    var lvOf = function (size) { var s = Math.round(size * 2) / 2, i; for (i = 0; i < big.length; i++) if (Math.abs(big[i] - s) < 0.6) return i + 1; return 0 };
    var out = [], para = '';
    function flush() { if (para.trim()) out.push(para.trim()); para = '' }
    pages.forEach(function (pg) {
      var prevL = null, items = [], run = [];
      function endRun() { if (run.length >= 2) items.push({ table: run.map(function (r) { return r.cols }) }); else run.forEach(function (r) { items.push(r) }); run = [] }
      pg.lines.forEach(function (l) {
        if (l.cols.length >= 2 && !BULLET.test(l.t) && (!run.length || Math.abs(run[run.length - 1].cols.length - l.cols.length) <= 1)) run.push(l);
        else { endRun(); if (l.cols.length >= 2 && !BULLET.test(l.t)) run.push(l); else items.push(l) }
      });
      endRun();
      items.forEach(function (l) {
        if (l.table) { flush(); out.push(mdTable(l.table)); prevL = null; return }
        var lv = lvOf(l.size), isHead = lv && l.t.length < 140 && !/[.;,]$/.test(l.t);
        if (isHead) { flush(); out.push('#'.repeat(lv) + ' ' + l.t); prevL = null; return }
        var gap = prevL ? prevL.y - l.y : 0, lh = Math.max(l.size, prevL ? prevL.size : l.size) * 1.45;
        var bullet = BULLET.test(l.t), numbered = /^\d{1,2}[.)]\s+\S/.test(l.t), lowerStart = /^[a-z(]/.test(l.t);
        var newPara = !prevL || bullet || numbered || (gap > lh * 1.12 && !lowerStart) || (l.x > (prevL ? prevL.x : 0) + l.size * 1.5 && gap > 0 && !lowerStart && /[.:!?]$/.test(para));
        if (newPara) { flush(); para = bullet ? '- ' + l.t.replace(BULLET, '') : l.t }
        else if (/[A-Za-z]-$/.test(para) && /^[a-z]/.test(l.t)) para = para.slice(0, -1) + l.t;
        else para += ' ' + l.t;
        if (bullet || numbered) { /* keep list items on their own line */ out.push(para); para = '' }
        prevL = l;
      });
      /* a page break is a soft break: a sentence can continue on the next page */
    });
    flush();
    var text = out.join('\n\n');
    var title = ''; try { var md = await pdf.getMetadata(); title = (md && md.info && md.info.Title || '').trim(); if (/^(untitled|microsoft word.*|document\d*|slide \d+)$/i.test(title)) title = '' } catch (e) {}
    try { pdf.destroy() } catch (e) {}
    return { text: text, title: title, pages: n };
  }

  /* ---------------------------------------------------------------- public */
  async function toBytes(src) {
    if (src && src.bytes && typeof src.bytes !== 'function') return { u8: src.bytes instanceof Uint8Array ? src.bytes : new Uint8Array(src.bytes), name: src.name || '' };
    if (src && src.b64) return { u8: b64ToBytes(src.b64), name: src.name || '' };
    if (src && typeof src.arrayBuffer === 'function') return { u8: new Uint8Array(await src.arrayBuffer()), name: src.name || '' };
    throw fail('No file was given.', 'arg');
  }
  async function read(src, opts) {
    opts = opts || {};
    var f = await toBytes(src), u8 = f.u8, kind = sniff(u8, f.name), warn = [], res;
    if (!u8.length) throw fail('That file is empty.', 'empty');
    if (opts.onProgress) opts.onProgress('Opening ' + (f.name || 'file') + '…');
    if (kind === 'pdf') res = await readPdf(u8, opts, warn);
    else if (kind === 'docx') res = await readDocx(openZip(u8), warn);
    else if (kind === 'pptx') res = await readPptx(openZip(u8), warn);
    else if (kind === 'odt' || kind === 'odp') res = await readOdf(openZip(u8), kind, warn);
    else if (kind === 'rtf') res = { text: readRtf(u8) };
    else if (kind === 'html') res = { text: readHtml(decodeText(u8)) };
    else if (kind === 'csv' || kind === 'tsv') { var raw = decodeText(u8); res = { text: readCsv(raw, kind === 'tsv' ? '\t' : (raw.split('\n')[0].split(';').length > raw.split('\n')[0].split(',').length ? ';' : ',')) } }
    else if (kind === 'legacy') throw fail('Old Word and PowerPoint files (.doc, .ppt) cannot be read. Open the file and save it as .docx or .pptx (or PDF), then try again.', 'legacy');
    else if (kind === 'zip') throw fail('That type of file is not supported. Use PDF, Word (.docx), PowerPoint (.pptx), or a text file.', 'format');
    else {
      var head = u8.subarray(0, Math.min(u8.length, 4000)), bad = 0, i;
      for (i = 0; i < head.length; i++) if (head[i] === 0 || (head[i] < 9) || (head[i] > 13 && head[i] < 32)) bad++;
      if (bad > head.length * 0.05 && !(u8[0] === 0xFF && u8[1] === 0xFE) && !(u8[0] === 0xFE && u8[1] === 0xFF)) throw fail('That file does not contain readable text. Use PDF, Word (.docx), PowerPoint (.pptx) or a text file.', 'binary');
      res = { text: decodeText(u8) };
    }
    var text = joinLists(tidy(res.text || ''));
    var base = String(f.name || '').replace(/\.[^.]+$/, '') || 'Imported file';
    if (!text) throw fail('No text found in that file.', 'empty');
    return { name: base, title: res.title || '', text: text, kind: kind, pages: res.pages, warnings: warn };
  }

  window.DocReader = { read: read, ACCEPT: ACCEPT, sniff: sniff, _unzip: openZip, _decode: decodeText };
})();
