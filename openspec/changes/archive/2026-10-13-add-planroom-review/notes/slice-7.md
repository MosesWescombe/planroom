# Slice 7 notes: the html block in a browser

Checked on 2026-10-08 in Chromium against the built page, with a review of a throwaway branch driven over stdio.

- A probe page served with Planroom's own policy (`script-src 'self'`) and an `<iframe sandbox="allow-scripts" srcdoc>`
  blocked the frame's inline script: Chromium reported `Executing inline script violates ... 'script-src 'self''
  @ about:srcdoc`. A `srcdoc` frame inherits its parent's policy, so the live page cannot run the block that way.
- Served from `api/frame/<blockId>` with `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline';
  style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox allow-scripts`, the same document runs its script.
  Its `fetch('https://example.com')` is refused (`violates ... "default-src 'none'"`), reading `parent.document` throws
  and `localStorage` throws.
- `html-sandbox.png`: the review page's Trade-offs slide, with a slider-driven `html` block alone on the slide, filling
  it, labelled "interactive, sandboxed", and showing "2 attempts (network blocked)": its script ran and its request was
  blocked.
- In the same run, an SVG asset holding `<script>document.title="pwned"</script>` animated through SMIL and its script
  did not run; the page title stayed `branch-feature-retry-cap · Planroom`.
