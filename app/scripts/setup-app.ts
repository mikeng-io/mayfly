/**
 * Mayfly install helper — the one-button GitHub App setup.
 *
 * Run AFTER `cd app/infra && npm run deploy` (which writes app/cdk-outputs.json):
 *   npm run setup-app                 # personal account
 *   npm run setup-app -- --org=ORG    # install under an org
 *
 * It starts a tiny local server, opens your browser to a page that POSTs a GitHub
 * App *manifest* (pre-seeded with the deployed Function URL + exactly Mayfly's
 * permissions), and on the redirect back exchanges the code for the App's id,
 * private key, and webhook secret — writing them straight into SSM + Secrets
 * Manager. No permission clicking, no secret copy-paste.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildManifest,
  exchangeManifestCode,
  persistCredentials,
  newAppUrl,
  installUrl,
  type AppCredentials,
} from '../src/lib/manifest';

const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name: string, def = ''): string {
  const p = `--${name}=`;
  return process.argv.find((a) => a.startsWith(p))?.slice(p.length) ?? def;
}

const port = Number(arg('port', '8722'));
const org = arg('org');
const region = arg('region', process.env.MAYFLY_REGION || 'ap-northeast-1');
const outputsPath = arg('outputs', path.join(here, '..', 'cdk-outputs.json'));

function loadOutputs(): Record<string, string> {
  if (!existsSync(outputsPath)) return {};
  const raw = JSON.parse(readFileSync(outputsPath, 'utf8')) as Record<string, Record<string, string>>;
  return raw['MayflyStack'] ?? Object.values(raw)[0] ?? {};
}
const out = loadOutputs();

const functionUrl = arg('function-url', out.WebhookUrl ?? '');
const webhookSecretParam = arg('webhook-secret-param', out.WebhookSecretParamName ?? '/mayfly/webhookSecret');
const appIdParam = arg('app-id-param', out.AppIdParamName ?? '/mayfly/appId');
const appKeySecretId = arg('app-key-secret', out.AppKeySecretName ?? '/mayfly/appPrivateKey');

if (!functionUrl) {
  console.error(
    'No Function URL found. Deploy first (cd app/infra && npm run deploy) or pass --function-url=https://…',
  );
  process.exit(1);
}

const redirectUrl = `http://localhost:${port}/callback`;
const state = randomBytes(16).toString('hex');
const manifest = buildManifest({ functionUrl, redirectUrl });

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;');

function shell(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
  :root{--bg:#12100e;--card:#1b1815;--ink:#efe9e2;--muted:#a99e91;--border:#2a2621;--ember:#e87a3c;--ok:#5cb85c}
  @media(prefers-color-scheme:light){:root{--bg:#f8f7f5;--card:#fff;--ink:#181410;--muted:#63594e;--border:#e4dfd8;--ember:#c2521c}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
    font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    display:flex;min-height:100vh;align-items:center;justify-content:center;padding:32px}
  .card{max-width:560px;width:100%;background:var(--card);border:1px solid var(--border);
    border-radius:16px;padding:36px 34px;box-shadow:0 18px 50px rgba(0,0,0,.28)}
  .eyebrow{font:600 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--ember);margin:0 0 14px}
  h1{font-size:26px;letter-spacing:-.02em;margin:0 0 10px}
  p{color:var(--muted);margin:0 0 16px}
  ul{color:var(--muted);margin:0 0 22px;padding-left:18px}li{margin:4px 0}
  code{font:13px ui-monospace,Menlo,monospace;background:rgba(232,122,60,.12);color:var(--ember);padding:1px 6px;border-radius:5px}
  .btn{display:inline-block;background:var(--ember);color:#fff;font-weight:640;font-size:15px;
    border:0;border-radius:10px;padding:13px 22px;cursor:pointer;text-decoration:none}
  .btn:hover{filter:brightness(1.07)}
  .ok{color:var(--ok);font-weight:640}
  .foot{margin:22px 0 0;font:12px ui-monospace,Menlo,monospace;color:var(--muted)}
</style></head><body><div class="card">${inner}</div></body></html>`;
}

function formPage(): string {
  return shell(
    'Create the Mayfly GitHub App',
    `<p class="eyebrow">Mayfly · install</p>
     <h1>Create your Mayfly GitHub App</h1>
     <p>One click creates a GitHub App wired to <strong>your</strong> deployed control plane and installs
        exactly the access it needs — nothing to configure by hand:</p>
     <ul>
       <li><strong>Administration</strong>: write — register ephemeral JIT runners</li>
       <li><strong>Actions</strong>: read — re-check queued jobs &amp; detect fork PRs</li>
       <li>Subscribes to the <code>workflow_job</code> event</li>
       <li>Webhook → <code>${esc(functionUrl)}</code></li>
     </ul>
     <form action="${esc(newAppUrl(state, org || undefined))}" method="post">
       <input type="hidden" name="manifest" value='${esc(JSON.stringify(manifest))}'>
       <button class="btn" type="submit">Create the Mayfly GitHub App →</button>
     </form>
     <p class="foot">You can rename the App on GitHub's next screen. Target: ${org ? `org <code>${esc(org)}</code>` : 'your personal account'}.</p>`,
  );
}

function successPage(creds: AppCredentials): string {
  return shell(
    'Mayfly App ready',
    `<p class="eyebrow">Mayfly · install</p>
     <h1><span class="ok">✓</span> App created &amp; secrets stored</h1>
     <p>App <strong>${esc(creds.slug)}</strong> (id <code>${creds.appId}</code>) is created. Its id, private
        key, and webhook secret are written to your AWS account (<code>${esc(region)}</code>). One step left —
        install it on the repos that should use Mayfly runners:</p>
     <a class="btn" href="${esc(installUrl(creds.slug))}">Install on your repositories →</a>
     <p class="foot">Then add <code>runs-on: [self-hosted, mayfly]</code> to a workflow. You can close this tab.</p>`,
  );
}

function errorPage(msg: string): string {
  return shell(
    'Setup error',
    `<p class="eyebrow">Mayfly · install</p><h1>Setup couldn't finish</h1>
     <p>${esc(msg)}</p><p class="foot">Fix the issue and re-run <code>npm run setup-app</code>.</p>`,
  );
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const html = (code: number, body: string): void => {
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  };

  if (url.pathname === '/') return html(200, formPage());

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    if (url.searchParams.get('state') !== state) return html(400, errorPage('State mismatch — restart setup.'));
    if (!code) return html(400, errorPage('GitHub returned no code.'));
    try {
      const creds = await exchangeManifestCode(code);
      await persistCredentials(creds, { region, webhookSecretParam, appIdParam, appKeySecretId });
      html(200, successPage(creds));
      console.log(`\n✓ App "${creds.slug}" (id ${creds.appId}) created; secrets written to AWS (${region}).`);
      console.log(`  Install it: ${installUrl(creds.slug)}\n`);
      setTimeout(() => server.close(() => process.exit(0)), 1500);
    } catch (e) {
      html(500, errorPage(e instanceof Error ? e.message : String(e)));
      console.error('setup failed:', e);
    }
    return;
  }
  return html(404, 'not found');
});

function openBrowser(u: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [u], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* user can open it manually */
  }
}

server.listen(port, () => {
  const u = `http://localhost:${port}/`;
  console.log(`\nMayfly App setup running.`);
  console.log(`  Webhook target : ${functionUrl}`);
  console.log(`  Region         : ${region}`);
  console.log(`  Open           : ${u}\n`);
  openBrowser(u);
});
