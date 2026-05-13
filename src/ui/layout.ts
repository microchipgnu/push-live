export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// Design tokens + components. Shared across landing, dashboard, signin,
// claim, pricing, docs. Keep this string lean — every page ships it inline.
export const BASE_STYLE = `
:root{
  --canvas:#F7F6F3;
  --surface:#FFFFFF;
  --surface-sunk:#F0EFEC;
  --rule:#EAEAEA;
  --rule-strong:#D8D6D1;
  --ink:#111111;
  --ink-soft:#2F3437;
  --muted:#787774;
  --muted-soft:#B9B9B5;
  --pale-blue-bg:#E1F3FE;   --pale-blue-fg:#1F6C9F;
  --pale-green-bg:#EDF3EC;  --pale-green-fg:#346538;
  --pale-yellow-bg:#FBF3DB; --pale-yellow-fg:#956400;
  --pale-red-bg:#FDEBEC;    --pale-red-fg:#9F2F2D;
  --pale-violet-bg:#F2EBF5; --pale-violet-fg:#5B3A7C;
  --serif:"Instrument Serif","Iowan Old Style","New York","Times New Roman",Times,serif;
  --sans:-apple-system,BlinkMacSystemFont,"Helvetica Neue","Segoe UI",Helvetica,Arial,sans-serif;
  --mono:ui-monospace,"SF Mono","JetBrains Mono","Geist Mono",Menlo,Consolas,monospace;
  --radius:10px;
  --radius-sm:6px;
  --radius-pill:9999px;
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;
  background:var(--canvas);
  color:var(--ink);
  font:15px/1.6 var(--sans);
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
  text-rendering:optimizeLegibility;
}
::selection{background:#111;color:#fff}

/* nav */
.nav{position:sticky;top:0;z-index:20;background:rgba(247,246,243,.82);backdrop-filter:saturate(140%) blur(10px);-webkit-backdrop-filter:saturate(140%) blur(10px);border-bottom:1px solid var(--rule)}
.nav__inner{max-width:68rem;margin:0 auto;padding:.95rem 1.5rem;display:flex;align-items:center;justify-content:space-between;gap:1rem}
.nav__brand{font-family:var(--serif);font-size:1.35rem;letter-spacing:-.02em;color:var(--ink);text-decoration:none}
.nav__brand em{font-style:italic;color:var(--muted)}
.nav__links{display:flex;align-items:center;gap:1.4rem}
.nav__links a,.nav__links button.link{color:var(--muted);font-size:13.5px;text-decoration:none;background:0;border:0;padding:0;cursor:pointer;font:inherit;transition:color 160ms ease}
.nav__links a:hover,.nav__links button.link:hover{color:var(--ink)}
.nav__links a.nav__cta{padding:.45rem .9rem;background:var(--ink);color:#fff;border-radius:var(--radius-sm);font-size:13px;font-weight:500}
.nav__links a.nav__cta:hover{background:#2a2a2a;color:#fff}

/* layout */
main{max-width:60rem;margin:0 auto;padding:4rem 1.5rem 6rem}
.wide{max-width:68rem;margin:0 auto;padding:0 1.5rem}

/* typography */
h1,h2,h3,h4{font-family:var(--serif);color:var(--ink);font-weight:400;letter-spacing:-.02em}
h1{font-size:2.4rem;line-height:1.05;margin:0 0 .6rem}
h1 em{font-style:italic;color:var(--muted)}
h2{font-size:1.45rem;line-height:1.15;margin:2.4rem 0 .8rem}
h3{font-size:1.1rem;line-height:1.3;margin:1.4rem 0 .35rem}
h4{font-size:.95rem;line-height:1.4;font-family:var(--sans);font-weight:600;margin:0 0 .35rem;letter-spacing:-.005em}
p{color:var(--ink-soft);margin:0 0 1rem;line-height:1.65}
.lede{color:var(--muted);font-size:1rem;max-width:38rem}
.muted{color:var(--muted);font-size:13px}
.eyebrow{display:inline-block;font:500 11px/1 var(--sans);color:var(--muted);text-transform:uppercase;letter-spacing:.12em;margin:0 0 1.1rem}
a{color:var(--ink);text-decoration:underline;text-decoration-color:rgba(0,0,0,.18);text-underline-offset:3px;transition:text-decoration-color 160ms ease}
a:hover{text-decoration-color:var(--ink)}

/* card */
.card{background:var(--surface);border:1px solid var(--rule);border-radius:var(--radius);padding:1.5rem 1.75rem;margin:0 0 1.25rem;transition:border-color 200ms ease,box-shadow 200ms ease}
.card>h2:first-child,.card>h3:first-child,.card>h4:first-child{margin-top:0}
.card--quiet{background:transparent;border-style:dashed}

/* table */
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{text-align:left;padding:.75rem .35rem;border-bottom:1px solid var(--rule);vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.08em}
tbody tr:last-child td{border-bottom:0}
td.right,th.right{text-align:right}
td.code,td .code{font:13px/1.45 var(--mono)}

/* forms */
label.label,.label{display:block;font:500 12px/1.4 var(--sans);color:var(--muted);margin:0 0 .35rem;letter-spacing:.02em}
input,select,textarea{font:14px/1.5 var(--sans);color:var(--ink);background:var(--surface);border:1px solid var(--rule);border-radius:var(--radius-sm);padding:.6rem .8rem;width:100%;transition:border-color 140ms ease,box-shadow 140ms ease}
input:focus,select:focus,textarea:focus{outline:0;border-color:var(--ink);box-shadow:0 0 0 3px rgba(17,17,17,.06)}
input[type=checkbox]{width:auto;accent-color:var(--ink)}

/* buttons */
button,.btn{display:inline-block;font:500 14px/1 var(--sans);letter-spacing:-.005em;padding:.65rem 1.1rem;background:var(--ink);color:#fff;border:0;border-radius:var(--radius-sm);cursor:pointer;text-decoration:none;transition:background 160ms ease,transform 100ms ease,border-color 160ms ease}
button:hover,.btn:hover{background:#2a2a2a}
button:active,.btn:active{transform:scale(.985)}
button.secondary,.btn.secondary,.btn--ghost{background:var(--surface);color:var(--ink);border:1px solid var(--rule)}
button.secondary:hover,.btn.secondary:hover,.btn--ghost:hover{border-color:var(--ink);background:var(--surface)}
.btn--danger{background:var(--pale-red-bg);color:var(--pale-red-fg)}
.btn--danger:hover{background:#f9d5d8}
.btn--block{display:block;width:100%;text-align:center}
.btn--sm{padding:.4rem .75rem;font-size:12.5px}

/* tags / pills */
.tag{display:inline-flex;align-items:center;gap:.25em;padding:.18em .6em;font:500 10.5px/1.5 var(--sans);text-transform:uppercase;letter-spacing:.08em;border-radius:var(--radius-pill);background:var(--surface-sunk);color:var(--muted)}
.tag--blue{background:var(--pale-blue-bg);color:var(--pale-blue-fg)}
.tag--green{background:var(--pale-green-bg);color:var(--pale-green-fg)}
.tag--yellow{background:var(--pale-yellow-bg);color:var(--pale-yellow-fg)}
.tag--red{background:var(--pale-red-bg);color:var(--pale-red-fg)}
.tag--violet{background:var(--pale-violet-bg);color:var(--pale-violet-fg)}

/* code + kbd */
code,.code{font:13px/1.45 var(--mono);background:var(--surface-sunk);padding:.13em .4em;border-radius:4px;color:var(--ink)}
pre{margin:0;padding:1rem 1.1rem;background:#0E0E0E;color:#EDECE6;border-radius:var(--radius-sm);font:12.5px/1.55 var(--mono);overflow-x:auto}
pre code{background:transparent;padding:0;color:inherit}
kbd{display:inline-block;font:11.5px/1 var(--mono);padding:.32em .55em;border:1px solid var(--rule);border-bottom-width:2px;border-radius:5px;background:var(--surface);color:var(--ink);vertical-align:baseline}

/* alerts */
.alert{padding:.8rem 1rem;border:1px solid var(--rule);border-radius:var(--radius-sm);font-size:13.5px;margin:0 0 1.25rem;background:var(--surface)}
.alert.error{background:var(--pale-red-bg);color:var(--pale-red-fg);border-color:transparent}
.alert.ok{background:var(--pale-green-bg);color:var(--pale-green-fg);border-color:transparent}

/* utility rows */
.row{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
.cluster{display:flex;gap:.4rem;align-items:center;flex-wrap:wrap}
.stack-sm>*+*{margin-top:.5rem}
.stack>*+*{margin-top:1rem}
.divider{height:1px;background:var(--rule);border:0;margin:2rem 0}

/* gentle on-load fade-in */
.reveal{animation:reveal 700ms cubic-bezier(.16,1,.3,1) both;animation-delay:var(--reveal-delay,0ms)}
@keyframes reveal{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}

footer{border-top:1px solid var(--rule);margin-top:5rem;padding:2.5rem 1.5rem;color:var(--muted);font-size:13px;text-align:center;background:var(--canvas)}
footer a{color:var(--muted);margin:0 .55rem;text-decoration:none}
footer a:hover{color:var(--ink)}

@media (max-width:720px){
  main{padding:2.75rem 1.25rem 4rem}
  h1{font-size:1.9rem}
  h2{font-size:1.25rem}
  .card{padding:1.2rem 1.25rem}
  .nav__links{gap:.9rem}
}
@media (prefers-reduced-motion:reduce){
  .reveal{animation:none}
  *,*::before,*::after{animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important;scroll-behavior:auto !important}
}
`;

// CSS handles the fade-in via animation; this slot stays for any future
// progressive enhancement (e.g. staggered scroll triggers) and keeps the
// shell signature stable.
export const REVEAL_SCRIPT = `/* fade-in is CSS-only */`;

const FONT_PRECONNECT = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">`;

export function head(title: string, extraStyle = ''): string {
  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
${FONT_PRECONNECT}
<style>${BASE_STYLE}${extraStyle}</style>`;
}

export function shell(title: string, body: string, opts: { user?: string | null; extraStyle?: string } = {}): string {
  const signOut = `<form method="post" action="/signout" style="display:inline"><button type="submit" class="link">Sign out</button></form>`;
  const links = opts.user
    ? `<a href="/dashboard">Dashboard</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a>${signOut}`
    : `<a href="/pricing">Pricing</a><a href="/docs">Docs</a><a class="nav__cta" href="/signin">Sign in</a>`;
  return `<!doctype html>
<html lang="en"><head>${head(title, opts.extraStyle ?? '')}</head>
<body>
<header class="nav"><div class="nav__inner">
  <a class="nav__brand" href="/">push<em>·</em>live</a>
  <div class="nav__links">${links}</div>
</div></header>
<main>${body}</main>
<footer>
  <a href="/docs">Docs</a> · <a href="/pricing">Pricing</a> · <a href="/openapi.json">OpenAPI</a> · <a href="/llms.txt">llms.txt</a>
  <div style="margin-top:.6rem;font-size:12px"><a href="https://github.com/microchipgnu/push-live">Source available on GitHub</a></div>
</footer>
<script>${REVEAL_SCRIPT}</script>
</body></html>`;
}
