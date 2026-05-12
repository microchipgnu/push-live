export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export const BASE_STYLE = `
*,*::before,*::after{box-sizing:border-box}
body{font:14.5px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif;color:#18181b;background:#fafafa;margin:0}
nav{position:sticky;top:0;background:#fff;border-bottom:1px solid #e4e4e7;padding:.8rem 1.5rem;display:flex;justify-content:space-between;align-items:center}
nav a{color:#18181b;text-decoration:none;font-weight:600;letter-spacing:-.01em}
nav .right a{margin-left:1.2rem;font-weight:400;color:#52525b;font-size:13px}
main{max-width:64rem;margin:0 auto;padding:2.5rem 1.5rem}
h1{font-size:1.5rem;margin:0 0 .4rem;letter-spacing:-.02em}
h2{font-size:1.05rem;margin:2rem 0 .6rem}
p{color:#3f3f46;margin:0 0 1rem}
.card{background:#fff;border:1px solid #e4e4e7;border-radius:6px;padding:1.25rem 1.5rem;margin-bottom:1rem}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:.55rem .25rem;text-align:left;border-bottom:1px solid #f4f4f5}
th{color:#71717a;font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
input,select,textarea{font:inherit;padding:.55rem .7rem;border:1px solid #d4d4d8;border-radius:5px;background:#fff;width:100%}
button,.btn{display:inline-block;font:inherit;padding:.5rem 1rem;border:0;border-radius:5px;background:#18181b;color:#fff;cursor:pointer;text-decoration:none}
button.secondary,.btn.secondary{background:#fff;color:#18181b;border:1px solid #d4d4d8}
.btn.danger{background:#dc2626}
.row{display:flex;gap:.6rem;align-items:center}
small,.muted{color:#71717a;font-size:12.5px}
.code{font:13px ui-monospace,Menlo,monospace;background:#f4f4f5;padding:.1em .35em;border-radius:3px}
.alert{padding:.7rem 1rem;border-radius:5px;font-size:13.5px;margin-bottom:1rem}
.alert.error{background:#fee2e2;color:#991b1b}
.alert.ok{background:#dcfce7;color:#166534}
`;

export function shell(title: string, body: string, opts: { user?: string | null } = {}): string {
  const signOut = `<form method="post" action="/signout" style="display:inline">
    <button type="submit" style="background:none;border:0;padding:0;color:#52525b;font:inherit;cursor:pointer;margin-left:1.2rem">Sign out</button>
  </form>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${BASE_STYLE}</style></head>
<body><nav><a href="/">sloop</a><div class="right">
${opts.user ? `<a href="/dashboard">Dashboard</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a>${signOut}` : `<a href="/pricing">Pricing</a><a href="/docs">Docs</a><a href="/signin">Sign in</a>`}
</div></nav>
<main>${body}</main></body></html>`;
}
