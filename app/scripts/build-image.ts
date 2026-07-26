/**
 * Build/update the Mayfly MicroVM runner image via the AWS SDK.
 *
 * Replaces the `aws lambda-microvms` calls in build-image.sh, which require a recent
 * AWS CLI v2. On an older CLI the service is simply unknown, argparse prints its usage
 * to STDOUT, the script's `>/dev/null` swallows it, and `set -e` exits 0-output — a
 * silent no-op that looks like a successful build. The JS SDK is already a dependency
 * and is what the control plane itself uses, so drive the API from here instead.
 *
 *   npm run build-image                  # lean runner image (default)
 *   IMAGE_NAME=mayfly-runner npm run build-image
 */
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  LambdaMicrovmsClient,
  ListMicrovmImagesCommand,
  CreateMicrovmImageCommand,
  UpdateMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  type MicrovmImageSummary,
} from '@aws-sdk/client-lambda-microvms';

// fileURLToPath, not import.meta.dirname: the latter needs Node >= 20.11 while INSTALL.md
// promises "Node 20+", where it is undefined and path.resolve throws. setup-app.ts does the same.
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGION = process.env.MAYFLY_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-1';
const IMAGE_NAME = process.env.IMAGE_NAME ?? 'mayfly-runner';
const BASE_IMAGE_ARN =
  process.env.BASE_IMAGE_ARN ?? `arn:aws:lambda:${REGION}:aws:microvm-image:al2023-1`;

const lm = new LambdaMicrovmsClient({ region: REGION });

/** Look the image up by name — GetMicrovmImage needs the ARN, which we may not have yet. */
async function image(): Promise<MicrovmImageSummary | undefined> {
  let token: string | undefined;
  do {
    const res = await lm.send(new ListMicrovmImagesCommand({ nextToken: token }));
    const hit = (res.items ?? []).find((i) => i.name === IMAGE_NAME);
    if (hit) return hit;
    token = res.nextToken;
  } while (token);
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const outPath = path.join(APP_ROOT, 'cdk-outputs.json');
  if (!existsSync(outPath)) {
    throw new Error(`missing ${outPath} — deploy infra first: (cd infra && npm run deploy)`);
  }
  const outs = JSON.parse(readFileSync(outPath, 'utf8')).MayflyStack;
  const bucket = outs?.ArtifactBucketName;
  const buildRoleArn = outs?.BuildRoleArn;
  if (!bucket || !buildRoleArn) {
    throw new Error(`cdk-outputs.json missing ArtifactBucketName/BuildRoleArn — deploy infra first`);
  }

  // Stage so the Dockerfile sits at the zip root; its COPY paths are relative to that.
  const stage = mkdtempSync(path.join(tmpdir(), 'mayfly-img-'));
  try {
    copyFileSync(path.join(APP_ROOT, 'image', 'Dockerfile'), path.join(stage, 'Dockerfile'));
    mkdirSync(path.join(stage, 'runtime', 'launcher'), { recursive: true });
    copyFileSync(
      path.join(APP_ROOT, 'runtime', 'launcher', 'main.go'),
      path.join(stage, 'runtime', 'launcher', 'main.go'),
    );
    const zipPath = path.join(stage, 'app.zip');
    execFileSync('zip', ['-qr', zipPath, 'Dockerfile', 'runtime'], { cwd: stage });

    // Unique key per build so an update always ships new code.
    const key = `mayfly/app-${Math.floor(Date.now() / 1000)}.zip`;
    // `aws s3` works on any CLI vintage; it is only `lambda-microvms` that needs a recent one.
    console.log(`[build] upload s3://${bucket}/${key}`);
    execFileSync('aws', ['s3', 'cp', zipPath, `s3://${bucket}/${key}`, '--region', REGION], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });

    const hooks = process.env.MAYFLY_HOOKS ? JSON.parse(process.env.MAYFLY_HOOKS) : undefined;
    const common = {
      baseImageArn: BASE_IMAGE_ARN,
      buildRoleArn,
      codeArtifact: { uri: `s3://${bucket}/${key}` },
      ...(hooks ? { hooks } : {}),
    };

    // Keep the version THIS call creates. Polling the image's name-level fields instead is
    // wrong in both directions: latestFailedImageVersion is durable history ("the latest
    // failed version, if any"), so one past failure would make every later build report
    // "not healthy" forever; and on the update path the image still reads CREATED/UPDATED
    // from the previous build, so a poll landing before AWS flips it to UPDATING would
    // report success against the OLD version while the new build was still running.
    const existing = await image();
    let imageArn: string | undefined;
    let imageVersion: string | undefined;
    if (existing?.imageArn) {
      console.log(`[build] image exists (${existing.imageArn}) → update`);
      const res = await lm.send(
        new UpdateMicrovmImageCommand({ ...common, imageIdentifier: existing.imageArn }),
      );
      ({ imageArn, imageVersion } = res);
    } else {
      console.log('[build] create');
      const res = await lm.send(new CreateMicrovmImageCommand({ ...common, name: IMAGE_NAME }));
      ({ imageArn, imageVersion } = res);
    }
    if (!imageArn || !imageVersion) throw new Error('API returned no imageArn/imageVersion');
    console.log(`[build] building version ${imageVersion}`);

    process.stdout.write('[build] waiting for AWS to run the Dockerfile');
    for (let i = 0; i < 80; i++) {
      await sleep(15_000);
      const v = await lm.send(new GetMicrovmImageVersionCommand({ imageIdentifier: imageArn, imageVersion }));
      const state = v.state ?? '?';
      process.stdout.write(` ${state}`);
      if (state === 'SUCCESSFUL') {
        console.log();
        console.log(`[build] ✓ ${IMAGE_NAME} ready: ${imageArn} (version ${imageVersion})`);
        console.log('[build]   NOTE: record this image + version in app/AWS-LEDGER.md.');
        return;
      }
      // FAILED and the DELETE_* states are all terminal-and-not-success. Naming only the
      // states we expect would turn an unexpected one into a 20-minute silent spin.
      if (state !== 'PENDING' && state !== 'IN_PROGRESS') {
        console.log();
        throw new Error(
          `build did not succeed (state=${state}${v.stateReason ? `: ${v.stateReason}` : ''}) — ` +
            `logs: /aws/lambda/microvms/${IMAGE_NAME}`,
        );
      }
    }
    throw new Error(`TIMEOUT waiting for build of version ${imageVersion}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('[build]', e instanceof Error ? e.message : e);
  process.exit(1);
});
