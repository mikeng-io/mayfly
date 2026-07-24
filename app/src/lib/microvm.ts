import {
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  GetMicrovmCommand,
  TerminateMicrovmCommand,
  CreateMicrovmAuthTokenCommand,
  ListMicrovmImagesCommand,
  MicrovmState,
} from '@aws-sdk/client-lambda-microvms';

export interface RunResult {
  microvmId: string;
  endpoint: string;
  state?: string;
}

export interface MicrovmInfo {
  state?: string;
  endpoint?: string;
  stateReason?: string;
}

export interface MicrovmClientOptions {
  region: string;
  maxRuntimeSeconds: number;
  client?: LambdaMicrovmsClient;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface MicrovmClient {
  imageArn(name: string): Promise<string>;
  runMicrovm(imageArn: string, clientToken?: string): Promise<RunResult>;
  waitRunning(microvmId: string, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void>;
  getMicrovm(microvmId: string): Promise<MicrovmInfo>;
  authToken(microvmId: string): Promise<Record<string, string>>;
  postJit(
    endpoint: string,
    authHeaders: Record<string, string>,
    encodedJit: string,
    microvmId: string,
  ): Promise<void>;
  terminate(microvmId: string): Promise<void>;
}

/** MicroVM-managed network connectors (verified in the spike). */
export function networkConnectors(region: string): { ingress: string[]; egress: string[] } {
  const base = `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector`;
  return { ingress: [`${base}:ALL_INGRESS`], egress: [`${base}:INTERNET_EGRESS`] };
}

const TERMINAL = new Set<string>([MicrovmState.TERMINATED, MicrovmState.TERMINATING]);

export function createMicrovmClient(opts: MicrovmClientOptions): MicrovmClient {
  const client = opts.client ?? new LambdaMicrovmsClient({ region: opts.region });
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const nc = networkConnectors(opts.region);

  async function getMicrovm(microvmId: string): Promise<MicrovmInfo> {
    const res = await client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
    return { state: res.state, endpoint: res.endpoint, stateReason: res.stateReason };
  }

  return {
    getMicrovm,

    async imageArn(name) {
      let token: string | undefined;
      do {
        const res = await client.send(new ListMicrovmImagesCommand({ nextToken: token }));
        const hit = (res.items ?? []).find((i) => i.name === name);
        if (hit?.imageArn) return hit.imageArn;
        token = res.nextToken;
      } while (token);
      throw new Error(`MicroVM image not found: ${name}`);
    },

    async runMicrovm(imageArn, clientToken) {
      const res = await client.send(
        new RunMicrovmCommand({
          imageIdentifier: imageArn,
          ingressNetworkConnectors: nc.ingress,
          egressNetworkConnectors: nc.egress,
          maximumDurationInSeconds: opts.maxRuntimeSeconds,
          // No idlePolicy => auto-suspend OFF. The runner is outbound-only, so inbound-driven
          // auto-suspend would kill a mid-job VM (the spike's make-or-break finding).
          clientToken,
        }),
      );
      if (!res.microvmId || !res.endpoint) {
        throw new Error('RunMicrovm returned no microvmId/endpoint');
      }
      return { microvmId: res.microvmId, endpoint: res.endpoint, state: res.state };
    },

    async waitRunning(microvmId, o) {
      const timeoutMs = o?.timeoutMs ?? 120_000;
      const intervalMs = o?.intervalMs ?? 2_000;
      const deadline = now() + timeoutMs;
      for (;;) {
        const info = await getMicrovm(microvmId);
        if (info.state === MicrovmState.RUNNING) return;
        if (info.state && TERMINAL.has(info.state)) {
          throw new Error(
            `MicroVM ${microvmId} entered ${info.state}: ${info.stateReason ?? 'no reason'}`,
          );
        }
        if (now() > deadline) {
          throw new Error(
            `MicroVM ${microvmId} did not reach RUNNING within ${timeoutMs}ms (last=${info.state})`,
          );
        }
        await sleep(intervalMs);
      }
    },

    async authToken(microvmId) {
      const res = await client.send(
        new CreateMicrovmAuthTokenCommand({
          microvmIdentifier: microvmId,
          expirationInMinutes: 60,
          allowedPorts: [{ allPorts: {} }],
        }),
      );
      if (!res.authToken) throw new Error('CreateMicrovmAuthToken returned no token');
      return res.authToken;
    },

    /**
     * Hand the VM its JIT config, and its own identity alongside it. The guest cannot
     * derive that identity for itself: every VM is restored from one build snapshot, so
     * anything the kernel set at boot (boot_id, machine-id, hostname) is identical across
     * all of them. The control plane is the only party that knows which VM this is.
     */
    async postJit(endpoint, authHeaders, encodedJit, microvmId) {
      const res = await doFetch(`https://${endpoint}/jit`, {
        method: 'POST',
        headers: { ...authHeaders, 'X-aws-proxy-port': '8080', 'content-type': 'application/json' },
        body: JSON.stringify({ jitconfig: encodedJit, microvmId }),
      });
      if (!res.ok) throw new Error(`postJit failed: ${res.status}`);
    },

    async terminate(microvmId) {
      try {
        await client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
      } catch (e) {
        const name = (e as { name?: string }).name ?? '';
        // Idempotent: an already-gone / already-terminating VM is success for us.
        if (/NotFound|ResourceNotFound|Conflict|InvalidState/i.test(name)) return;
        throw e;
      }
    },
  };
}
