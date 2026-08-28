/** The browser-facing pages of the authorization flow: an administration picker and errors. */

const STYLE = `
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #fbfbfa; color: #1a1a18;
  }
  main { width: min(30rem, calc(100vw - 3rem)); padding: 2rem 0; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1.5rem; color: #5c5c56; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .5rem; }
  button {
    width: 100%; text-align: left; padding: .875rem 1rem; font: inherit; cursor: pointer;
    background: #fff; color: inherit; border: 1px solid #dcdcd6; border-radius: .5rem;
  }
  button:hover { border-color: #1a1a18; }
  .name { font-weight: 600; }
  .secondary { margin-top: 1rem; }
  .secondary button { text-align: center; color: #5c5c56; }
  .meta { color: #5c5c56; font-size: .875rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875rem; }
  @media (prefers-color-scheme: dark) {
    .secondary button { color: #a3a39c; }
    body { background: #171715; color: #f2f2ef; }
    p, .meta { color: #a3a39c; }
    button { background: #201f1d; border-color: #35342f; }
    button:hover { border-color: #f2f2ef; }
  }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function htmlResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export interface AdministrationChoice {
  id: string;
  name: string;
  country?: string | undefined;
  currency?: string | undefined;
}

/**
 * Asks which administration should be the default for this authorization.
 *
 * Moneybird's own consent screen grants the token everything the user can reach, so without a
 * default a client would have to name an administration on every single call. It is only a
 * default: a request that names an administration still reaches any of the others. Saying that
 * plainly matters, because a picker with one button per administration reads as a lock.
 */
export function administrationPage(
  administrations: readonly AdministrationChoice[],
  action: string,
): string {
  const items = administrations
    .map((administration) => {
      const meta = [administration.country, administration.currency]
        .filter((entry): entry is string => Boolean(entry))
        .join(' · ');
      return `<li>
      <form method="post" action="${escapeHtml(action)}">
        <input type="hidden" name="administration_id" value="${escapeHtml(administration.id)}">
        <button type="submit">
          <span class="name">${escapeHtml(administration.name)}</span><br>
          <span class="meta">${escapeHtml(meta || administration.id)}</span>
        </button>
      </form>
    </li>`;
    })
    .join('\n');

  return page(
    'Choose a default administration',
    `<h1>Choose a default administration</h1>
     <p>Used when a request does not name an administration. This connection reaches all of them
        either way — ask for one by name and that one is used.</p>
     <ul>${items}</ul>
     <form method="post" action="${escapeHtml(action)}" class="secondary">
       <input type="hidden" name="skip" value="1">
       <button type="submit">No default — name one on every request</button>
     </form>`,
  );
}

export function errorPage(title: string, detail: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`);
}
