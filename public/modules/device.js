// Environment facts about the device, shared by any feature that renders differently on a phone.
// Not a feature and not state — just constants derived once from the browser, so every module can
// import them without creating a dependency on another feature.

export const isMobile =
  typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** Phones and other touch-only devices send with the send button, not Enter. */
export const useMobileEnterBehavior =
  isMobile ||
  (typeof window !== 'undefined' &&
    !!window.matchMedia &&
    window.matchMedia('(pointer: coarse)').matches &&
    window.matchMedia('(hover: none)').matches);
