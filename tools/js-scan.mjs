// A real (small) JavaScript tokenizer, used by the client-side static checks.
//
// WHY THIS EXISTS: the first version of check-client-refs.mjs stripped comments and strings with
// regexes. That looked fine and was quietly, dangerously wrong — a template literal containing
// `${ ...{ nested braces }... }` breaks the naive backtick pattern, so it mis-pairs backticks and
// swallows everything in between. On public/app.js it collapsed 1,776 lines to 367 and reported
// "clean" while the app had a real boot-breaking undefined reference in the swallowed part.
//
// A checker that under-reports is worse than no checker, because you trust it. So: scan properly.

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[\w$]/;

/**
 * Replace every comment, string, template-literal chunk and regex literal with spaces, preserving
 * length and newlines so byte offsets and line numbers still line up with the original source.
 * Template-literal `${...}` EXPRESSIONS are kept — they are real code that can reference real names.
 */
export function blankNonCode(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  // Tracks whether a `/` begins a regex literal or is a division operator.
  let prevSignificant = '';
  // Stack of template-literal contexts; each `${` inside one pushes a brace depth to unwind.
  const templates = [];
  let braceDepth = 0;
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
      blank(i, Math.min(j + 2, src.length));
      i = j + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j += 1;
        if (src[j] === '\n') break; // unterminated: bail rather than eat the file
        j += 1;
      }
      blank(i, Math.min(j + 1, src.length));
      i = j + 1;
      prevSignificant = 'value';
      continue;
    }
    if (c === '`') {
      templates.push({ braceDepth });
      // Blank the backtick and walk the literal chunk-by-chunk, leaving ${...} expressions intact.
      blank(i, i + 1);
      i += 1;
      let chunkStart = i;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '`') {
          blank(chunkStart, i);
          blank(i, i + 1);
          i += 1;
          templates.pop();
          prevSignificant = 'value';
          break;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          blank(chunkStart, i);
          blank(i, i + 2); // the ${ itself
          i += 2;
          // Recursively scan the expression by continuing the outer loop with a brace guard.
          let depth = 1;
          const exprStart = i;
          // Find the matching close brace, honouring nested strings/templates/braces.
          const sub = scanToMatchingBrace(src, i);
          depth = 0;
          // Blank non-code INSIDE the expression too.
          const inner = blankNonCode(src.slice(exprStart, sub));
          for (let k = 0; k < inner.length; k += 1) out[exprStart + k] = inner[k];
          i = sub;
          blank(i, i + 1); // the closing }
          i += 1;
          chunkStart = i;
          continue;
        }
        i += 1;
      }
      continue;
    }
    if (c === '/' && canStartRegex(prevSignificant)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { closed = true; break; }
        j += 1;
      }
      if (closed) {
        while (j + 1 < src.length && /[a-z]/.test(src[j + 1])) j += 1; // flags
        blank(i, j + 1);
        i = j + 1;
        prevSignificant = 'value';
        continue;
      }
    }

    if (c === '{') braceDepth += 1;
    else if (c === '}') braceDepth -= 1;

    if (ID_START.test(c)) {
      let j = i;
      while (j < src.length && ID_PART.test(src[j])) j += 1;
      prevSignificant = KEYWORDS_BEFORE_REGEX.has(src.slice(i, j)) ? 'keyword' : 'value';
      i = j;
      continue;
    }
    if (/[)\]]/.test(c)) prevSignificant = 'value';
    else if (/\d/.test(c)) prevSignificant = 'value';
    else if (!/\s/.test(c)) prevSignificant = 'operator';
    i += 1;
  }

  return out.join('');
}

const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do',
  'else', 'yield', 'await',
]);

function canStartRegex(prev) {
  return prev !== 'value';
}

/** Index of the `}` matching an opening context that started at `from` (depth already 1). */
function scanToMatchingBrace(src, from) {
  let depth = 1;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '"' || c === "'") {
      const q = c;
      i += 1;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i += 1; i += 1; }
      i += 1;
      continue;
    }
    if (c === '`') {
      i += 1;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { i = scanToMatchingBrace(src, i + 2) + 1; continue; }
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 2; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return i; }
    i += 1;
  }
  return src.length;
}
