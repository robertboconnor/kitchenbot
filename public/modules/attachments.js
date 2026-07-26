// Chat file attachments: the paperclip menu, in-browser image downscaling, the preview chip,
// and the pending-attachment the composer sends.
//
// Owns pendingAttachment itself. The chat composer asks for it through this module's small public
// API (getPendingAttachment / clearPendingAttachment) rather than sharing a variable — a one-way
// dependency on a published interface, not a reach into internals.
//
// Android note: the three separate <input>s are load-bearing. One mixed image+text input collapses
// the picker to Camera + Files with no gallery entry; an image-only input with no `capture` is
// what surfaces "Photos".

let pendingAttachment = null;

/** The attachment staged for the next send, or null. */
export function getPendingAttachment() {
  return pendingAttachment;
}

/** Clear the staged attachment and its preview (called by the composer after sending). */
export function clearPendingAttachment() {
  pendingAttachment = null;
  resetAttachInputs();
  renderAttachmentPreview();
}

function attachInputElements() {
  return ['camera', 'photos', 'files']
    .map((source) => document.getElementById('attach-input-' + source))
    .filter(Boolean);
}

function resetAttachInputs() {
  attachInputElements().forEach((input) => {
    input.value = '';
  });
}

export async function downscaleImageToBase64(file, maxDim = 1600, quality = 0.85) {
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = dataUrl;
  });
  let width = img.width;
  let height = img.height;
  if (width > maxDim || height > maxDim) {
    const scale = maxDim / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality).split(',')[1];
}

export function renderAttachmentPreview() {
  const attachmentPreview = document.getElementById('attachment-preview');
  if (!attachmentPreview) return;
  attachmentPreview.innerHTML = '';
  if (!pendingAttachment) {
    attachmentPreview.style.display = 'none';
    return;
  }
  attachmentPreview.style.display = 'flex';
  const chip = document.createElement('div');
  chip.style.cssText =
    'display:inline-flex;align-items:center;gap:8px;padding:6px 8px;border-radius:10px;border:1px solid var(--border-subtle);background:var(--accent-soft);max-width:100%;';
  if (pendingAttachment.kind === 'image') {
    const thumb = document.createElement('img');
    thumb.src = 'data:' + pendingAttachment.mediaType + ';base64,' + pendingAttachment.data;
    thumb.style.cssText = 'width:40px;height:40px;object-fit:cover;border-radius:6px;';
    chip.appendChild(thumb);
  }
  const label = document.createElement('span');
  label.textContent =
    (pendingAttachment.kind === 'image' ? '📷 ' : '📄 ') +
    (pendingAttachment.name || (pendingAttachment.kind === 'image' ? 'photo' : 'file'));
  label.style.cssText = 'font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  chip.appendChild(label);
  const x = document.createElement('button');
  x.type = 'button';
  x.textContent = '×';
  x.title = 'Remove attachment';
  x.style.cssText = 'border:none;background:none;cursor:pointer;font-size:18px;line-height:1;color:var(--text-soft);padding:0 2px;';
  x.addEventListener('click', () => {
    pendingAttachment = null;
    resetAttachInputs();
    renderAttachmentPreview();
  });
  chip.appendChild(x);
  attachmentPreview.appendChild(chip);
}

export async function handleAttachFile(file) {
  if (!file) return;
  const nameLower = (file.name || '').toLowerCase();
  const isImage = (file.type || '').startsWith('image/');
  const isText =
    file.type === 'text/plain' ||
    file.type === 'text/markdown' ||
    nameLower.endsWith('.md') ||
    nameLower.endsWith('.markdown') ||
    nameLower.endsWith('.txt');
  try {
    if (isImage) {
      const data = await downscaleImageToBase64(file);
      pendingAttachment = { kind: 'image', mediaType: 'image/jpeg', name: file.name || 'photo.jpg', data };
    } else if (isText) {
      const text = await file.text();
      if (text.length > 400000) {
        alert('That file is a bit too big (max ~400KB of text).');
        return;
      }
      pendingAttachment = {
        kind: 'text',
        mediaType: nameLower.endsWith('.md') || nameLower.endsWith('.markdown') ? 'text/markdown' : 'text/plain',
        name: file.name || 'file.txt',
        data: text,
      };
    } else {
      alert('I can read photos and text/markdown files — that type is not supported.');
      return;
    }
    renderAttachmentPreview();
  } catch (e) {
    alert('Could not read that file.');
  }
}

function closeAttachMenu() {
  const attachMenu = document.getElementById('attach-menu');
  const attachBtn = document.getElementById('attach-btn');
  if (!attachMenu) return;
  attachMenu.hidden = true;
  if (attachBtn) attachBtn.setAttribute('aria-expanded', 'false');
}

export function initAttachments() {
    const attachBtn = document.getElementById('attach-btn');
    const attachMenu = document.getElementById('attach-menu');
    const attachInputs = attachInputElements();
    if (!attachBtn || !attachMenu || !attachInputs.length) return;

    // The paperclip opens a small Camera / Photos / Files menu, each wired to its own input.
    // Android only surfaces an explicit gallery ("Photos") for an image-only input with no
    // capture; one mixed image+text input collapses to Camera + Files. All feed handleAttachFile.
    attachBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = attachMenu.hidden;
      attachMenu.hidden = !willOpen;
      attachBtn.setAttribute('aria-expanded', String(willOpen));
    });
    attachMenu.querySelectorAll('button[data-attach-src]').forEach((item) => {
      item.addEventListener('click', () => {
        const input = document.getElementById('attach-input-' + item.getAttribute('data-attach-src'));
        closeAttachMenu();
        if (input) input.click();
      });
    });
    attachInputs.forEach((input) => {
      input.addEventListener('change', () => {
        const f = input.files && input.files[0];
        if (f) handleAttachFile(f);
      });
    });
    document.addEventListener('click', (e) => {
      if (attachMenu.hidden) return;
      if (e.target === attachBtn || attachMenu.contains(e.target)) return;
      closeAttachMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !attachMenu.hidden) closeAttachMenu();
    });
  }
