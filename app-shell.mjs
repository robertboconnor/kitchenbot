function safeJsonForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function renderClientBootTags(bootData = {}, { scriptSrc = '/app.js' } = {}) {
  return [
    `<script id="kb-boot-data" type="application/json">${safeJsonForHtml(bootData)}</script>`,
    `<script src="${String(scriptSrc || '/app.js')}"></script>`,
  ].join('\n      ');
}
