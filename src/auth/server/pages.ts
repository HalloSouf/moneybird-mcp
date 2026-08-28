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
  .meta { color: #5c5c56; font-size: .875rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875rem; }
  @media (prefers-color-scheme: dark) {
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
 * Asks which administration this authorization is for.
 *
 * Moneybird's own consent screen grants the token everything the user can reach, so without this
 * step a client would have to name an administration on every single call. The choice is bound to
 * the credential, not to the client, and re-authorizing is how you change it.
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
    'Choose an administration',
    `<h1>Choose an administration</h1>
     <p>This connection will act on the administration you pick. Authorize again to change it.</p>
     <ul>${items}</ul>`,
  );
}

export function errorPage(title: string, detail: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`);
}
