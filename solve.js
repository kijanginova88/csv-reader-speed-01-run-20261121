// A faster drop-in for make.fun's own csv-reader 1.0.0: run(input) returns exactly
// csv-reader's answer {columns, rows, errors} for every input {text, header}.
//
// How it stays exact: it follows the reference's reading rule for rule, but reads
// with native string scans instead of one character at a time. A record whose line
// holds no quote and no carriage return is split natively (String.split); any line
// that does hold one is read a field at a time by an inlined scanner that mirrors
// the reference, using one native regex scan per special character. A quoted field
// whose closing quote is the next quote in the text, and which holds no line break,
// is sliced out whole. The reference's semantics, kept in full:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it one quote, and each CRLF or lone CR inside it is read as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended to it as it stands (quote_junk, when the field ends); a quote that
//     never closes is a literal character, and the text after it is read again as
//     an unquoted field (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it (every record when header is false), each padded with ""
//     (short_row, with fields: its count) or cut (long_row, with extra: the cut
//     fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on
//     (every LF, CRLF and lone CR inside a quoted field counted), row its record's
//     index in rows (null for the header), in the order met, a field's quote_junk
//     when the field ends and a record's short_row or long_row when it ends.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The next comma, line feed or carriage return at or after lastIndex. */
const SPECIAL = /[,\n\r]/g;
/** The next quote, carriage return or line feed at or after lastIndex. */
const QUOTED_SPECIAL = /["\r\n]/g;
/** The next quote, carriage return or line feed at or after lastIndex. */
const LINE_BREAK_OR_SPECIAL = /["\r\n]/g;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR
  // not followed by LF is dropped (stray_cr). Returns the field and how it ended;
  // `added` counts the characters kept in this call (the junk call's count decides
  // quote_junk, so a quoted prefix it was handed does not count). Only used for the
  // characters after a closing quote; plain unquoted fields are read inline below.
  function readUnquoted(value) {
    let added = 0;
    while (pos < n) {
      SPECIAL.lastIndex = pos;
      const m = SPECIAL.exec(text);
      if (m === null) {
        value += text.slice(pos);
        added += n - pos;
        pos = n;
        return { value, ended: END, added };
      }
      const idx = m.index;
      const c = m[0];
      if (c === ',') {
        if (idx > pos) {
          value += text.slice(pos, idx);
          added += idx - pos;
        }
        pos = idx + 1;
        return { value, ended: COMMA, added };
      }
      if (c === '\n') {
        if (idx > pos) {
          value += text.slice(pos, idx);
          added += idx - pos;
        }
        pos = idx + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // A CR: a line break with the LF that follows it, else dropped (stray_cr).
      if (text.charCodeAt(idx + 1) === 10) {
        if (idx > pos) {
          value += text.slice(pos, idx);
          added += idx - pos;
        }
        pos = idx + 2;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      if (idx > pos) {
        value += text.slice(pos, idx);
        added += idx - pos;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos = idx + 1;
    }
    return { value, ended: END, added };
  }

  // Reads a quoted field whose opening quote is at pos: the general case (a
  // doubled quote, or a line break inside the quotes). Returns the field and how
  // it ended. Only used when the fast quoted path below does not apply.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let closed = false;
    while (pos < n) {
      QUOTED_SPECIAL.lastIndex = pos;
      const m = QUOTED_SPECIAL.exec(text);
      if (m === null) {
        value += text.slice(pos);
        pos = n;
        break;
      }
      const idx = m.index;
      const c = m[0];
      if (c === '"') {
        if (text.charCodeAt(idx + 1) === 34) {
          if (idx > pos) value += text.slice(pos, idx);
          value += '"';
          pos = idx + 2;
          continue;
        }
        if (idx > pos) value += text.slice(pos, idx);
        pos = idx + 1;
        closed = true;
        break;
      }
      if (c === '\r') {
        // CRLF and a lone CR inside quotes are each one LF.
        if (idx > pos) value += text.slice(pos, idx);
        value += '\n';
        line += 1;
        pos = text.charCodeAt(idx + 1) === 10 ? idx + 2 : idx + 1;
        continue;
      }
      if (idx > pos) value += text.slice(pos, idx);
      value += '\n';
      line += 1;
      pos = idx + 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  // Closes one record's fields: a line left with no characters is no record, the
  // first record sets the width (and is the header when header is true), the rest
  // are padded or cut to it.
  function closeRecord(fields, quoted) {
    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // The fast path: the next quote, carriage return or line feed decides it in
    // one scan. A line feed first means this record's line holds no quote and no
    // carriage return but its closing CRLF, so every field in it is unquoted and
    // the record ends at the break; split it natively instead of reading it a
    // field at a time. No such character at all means the rest of the text is
    // one plain record. A quote or a carriage return first means the slow path.
    LINE_BREAK_OR_SPECIAL.lastIndex = pos;
    const lb = LINE_BREAK_OR_SPECIAL.exec(text);
    if (lb === null) {
      const fields = text.slice(pos).split(',');
      pos = n;
      closeRecord(fields, false);
      continue;
    }
    if (lb[0] === '\n') {
      let segEnd = lb.index;
      if (segEnd > pos && text.charCodeAt(segEnd - 1) === 13) segEnd -= 1;
      const fields = text.slice(pos, segEnd).split(',');
      pos = lb.index + 1;
      line += 1;
      closeRecord(fields, false);
      continue;
    }

    // The slow path: the line holds a quote or a stray CR, so read it a field at a time.
    const fields = [];
    let quoted = false;
    let ended = COMMA;
    while (ended === COMMA) {
      quoted = text.charCodeAt(pos) === 34;
      let value;
      if (quoted) {
        // Fast quoted field: the next quote closes it, with no doubled quote and
        // no line break inside, so slice it out whole.
        const close = text.indexOf('"', pos + 1);
        if (close !== -1 && text.charCodeAt(close + 1) !== 34) {
          const inner = text.slice(pos + 1, close);
          if (inner.indexOf('\n') === -1 && inner.indexOf('\r') === -1) {
            value = inner;
            pos = close + 1;
            if (pos >= n) {
              ended = END;
            } else {
              const c = text.charCodeAt(pos);
              if (c === 44) {
                pos += 1;
                ended = COMMA;
              } else if (c === 10) {
                pos += 1;
                line += 1;
                ended = LINE_BREAK;
              } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
                pos += 2;
                line += 1;
                ended = LINE_BREAK;
              } else {
                // What follows the closing quote is appended as it stands.
                const junk = readUnquoted(value);
                if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
                value = junk.value;
                ended = junk.ended;
              }
            }
            fields.push(value);
            continue;
          }
        }
        // General quoted field: a doubled quote, a line break inside, or one that never closes.
        const f = readQuoted();
        value = f.value;
        ended = f.ended;
      } else {
        // Unquoted field, read inline: up to the next comma or line break, a CR
        // not followed by LF dropped (stray_cr).
        value = '';
        while (true) {
          SPECIAL.lastIndex = pos;
          const m = SPECIAL.exec(text);
          if (m === null) {
            if (pos < n) value += text.slice(pos);
            pos = n;
            ended = END;
            break;
          }
          const idx = m.index;
          const c = m[0];
          if (c === ',') {
            if (idx > pos) value += text.slice(pos, idx);
            pos = idx + 1;
            ended = COMMA;
            break;
          }
          if (c === '\n') {
            if (idx > pos) value += text.slice(pos, idx);
            pos = idx + 1;
            line += 1;
            ended = LINE_BREAK;
            break;
          }
          if (text.charCodeAt(idx + 1) === 10) {
            if (idx > pos) value += text.slice(pos, idx);
            pos = idx + 2;
            line += 1;
            ended = LINE_BREAK;
            break;
          }
          if (idx > pos) value += text.slice(pos, idx);
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          pos = idx + 1;
        }
      }
      fields.push(value);
    }
    closeRecord(fields, quoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
