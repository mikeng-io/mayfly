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
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  LambdaMicrovmsClient,
  ListMicrovmImagesCommand,
  CreateMicrovmImageCommand,
  UpdateMicrovmImageCommand,
} from '@aws-sdk/client-lambda-microvms';

const APP_ROOT = path.resolve(import.meta.dirname, '..');
const REGION = process.env.MAYFLY_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-1';
const IMAGE_NAME = process.env.IMAGE_NAME ?? 'mayfly-runner';
const BASE_IMAGE_ARN =
  process.env.BASE_IMAGE_ARN ?? `arn:aws:lambda:${REGION}:aws:microvm-image:al2023-1`;

const lm = new LambdaMicrovmsClient({ region: REGION });

/** Poll list-microvm-images by name — get-microvm-image needs the ARN, which we may not have yet. */
async function image(): Promise<Record<string, unknown> | undefined> {
  let token: string | undefined;
  do {
    const res = await lm.send(new ListMicrovmImagesCommand({ nextToken: token }));
    const hit = (res.items ?? []).find((i) => i.name === IMAGE_NAME);
    if (hit) return hit as unknown as Record<string, unknown>;
    token = res.nextToken;
  } while (token);
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const outPath = path.join(APP_ROOT, 'cdk-outputs.json');
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

    const common = {
      baseImageArn: BASE_IMAGE_ARN,
      buildRoleArn,
      codeArtifact: { uri: `s3://${bucket}/${key}` },
    };
    const existing = await image();
    if (existing?.imageArn) {
      console.log(`[build] image exists (${existing.imageArn}) → update`);
      await lm.send(
        new UpdateMicrovmImageCommand({ ...common, imageIdentifier: existing.imageArn as string }),
      );
    } else {
      console.log('[build] create');
      await lm.send(new CreateMicrovmImageCommand({ ...common, name: IMAGE_NAME }));
    }

    process.stdout.write('[build] waiting for AWS to run the Dockerfile');
    for (let i = 0; i < 80; i++) {
      await sleep(15_000);
      const img = await image();
      const state = String(img?.state ?? '?');
      process.stdout.write(` ${state}`);
      if (state === 'CREATED' || state === 'UPDATED') {
        // A CREATED/UPDATED image can still carry a FAILED version — check both.
        const active = img?.latestActiveImageVersion;
        const failed = img?.latestFailedImageVersion;
        console.log();
        if (!active || failed) {
          throw new Error(`version not healthy (active=${active} failed=${failed})`);
        }
        console.log(`[build] ✓ ${IMAGE_NAME} ready: ${img?.imageArn} (version ${active})`);
        console.log('[build]   NOTE: record this image in app/AWS-LEDGER.md.');
        return;
      }
      if (state === 'CREATION_FAILED' || state === 'UPDATE_FAILED') {
        console.log();
        throw new Error(`build FAILED (${state}) — logs: /aws/lambda/microvms/${IMAGE_NAME}`);
      }
    }
    throw new Error('TIMEOUT waiting for build');
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('[build]', e instanceof Error ? e.message : e);
  process.exit(1);
});
