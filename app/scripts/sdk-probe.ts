/**
 * Task 7.5 preflight: validate that @aws-sdk/client-lambda-microvms works against a
 * real GA region before control.ts depends on it. Read-only (ListMicrovmImages) — no
 * resources created, no cost. Run: `npm run sdk-probe` with creds in the repo .env.
 */
import { LambdaMicrovmsClient, ListMicrovmImagesCommand } from '@aws-sdk/client-lambda-microvms';

const region = process.env.MAYFLY_REGION ?? 'ap-northeast-1';

async function main(): Promise<void> {
  const client = new LambdaMicrovmsClient({ region });
  const res = await client.send(new ListMicrovmImagesCommand({}));
  const items = res.items ?? [];
  console.log(`[probe] OK — region=${region} lambda-microvms reachable; images=${items.length}`);
  for (const i of items) console.log(`  - ${i.name} [${i.state}] ${i.imageArn}`);
}

main().catch((e: unknown) => {
  const err = e as { name?: string; message?: string };
  console.error(`[probe] FAILED: ${err.name ?? 'Error'}: ${err.message ?? e}`);
  process.exit(1);
});
