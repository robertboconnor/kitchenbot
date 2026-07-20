function normalizeKey(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/ /g, '_');
  return s;
}

function stripOuterFormatting(text) {
  let s = String(text ?? '').trim();
  while (s.length >= 2 && s.startsWith('`') && s.endsWith('`')) {
    s = s.slice(1, -1).trim();
  }
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' || a === "'") && a === b) {
      s = s.slice(1, -1).trim();
    }
  }
  return s;
}

export function normalizeMemoryKey(raw) {
  return normalizeKey(stripOuterFormatting(String(raw ?? '')));
}

export function normalizeMemoryValue(raw) {
  return stripOuterFormatting(String(raw ?? ''));
}

