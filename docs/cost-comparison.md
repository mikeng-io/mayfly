# Cost comparison — GitHub-hosted runners vs Mayfly (private repo)

_Marginal cost, private repo, Linux, **after** the plan's included free minutes. 2026-07-11._

> Interactive version: `docs/mayfly-cost.html` (sliders for job length / volume / AWS rate).

## Two framing facts

1. **Self-hosted runners consume zero GitHub Actions minutes.** GitHub only bills minutes for its
   *hosted* runners. So this is **GitHub's per-minute bill vs your AWS bill**, not one Actions bill vs another.
2. **GitHub bills rounded up to the whole minute, per job; Mayfly (AWS) bills per-second.** That rounding
   is a real Mayfly edge for short/frequent jobs.

## Assumptions (the Mayfly compute rate is the soft one)

| Input | Value | Note |
|---|---|---|
| GitHub-hosted x64 2-core | **$0.008 / min** | rounded up per job |
| GitHub-hosted arm64 2-core | **$0.005 / min** | rounded up per job |
| Mayfly compute (2 vCPU / 4 GB Graviton) | **≈ $0.002 / min**, per-second | ⚠️ **assumed** — Graviton/Lambda-arm proxy; confirm vs the real `lambda-microvms` rate. If 2–3× higher, shift Mayfly up. |
| Mayfly boot overhead | **~20 s / job** | added to billable VM time |
| Mayfly fixed monthly | **~$5 / mo** | DynamoDB + SQS + 3 Lambdas + alarms idle + ~2 GB image snapshot |
| Mayfly per-job control overhead | **< $0.0001** | SQS + Lambda + DynamoDB — negligible |

**Formulas**
- GitHub: `ceil(job_minutes) × rate`
- Mayfly: `((job_seconds + boot) / 60) × rate + (fixed / jobs_per_month)`

## Cost per job

| Job wall time | GitHub x64 | GitHub arm64 | Mayfly (+20 s boot) |
|---|---|---|---|
| 20 sec | $0.0080 | $0.0050 | **$0.0013** |
| 2 min | $0.0160 | $0.0100 | **$0.0047** |
| 8 min | $0.0640 | $0.0400 | **$0.0167** |
| 30 min | $0.2400 | $0.1500 | **$0.0607** |

## Monthly total (avg 6-min job, incl. Mayfly $5 fixed)

| Jobs / mo | GitHub x64 | GitHub arm64 | Mayfly |
|---|---|---|---|
| 200 | $9.60 | $6.00 | $7.53 |
| 500 | $24.00 | $15.00 | $11.33 |
| 1,000 | $48.00 | $30.00 | $17.67 |
| 5,000 | $240 | $150 | $68 |
| 20,000 | $960 | $600 | $258 |

**Break-even vs GitHub arm64 ≈ ~300 jobs/mo; vs x64 ≈ ~140 jobs/mo.**

## Verdict (honest)

- On the assumed rate, Mayfly's **marginal compute is ~2–4× cheaper**, widening for **short jobs**
  (per-second vs rounded-up minutes) and **high volume**.
- **The table excludes ops labor** — deploying and running the control plane. GitHub-hosted is zero-ops;
  that's the real price Mayfly trades away. **Under ~300 jobs/mo, don't pick Mayfly for cost.**
- Mayfly's *durable* advantages are **own-kernel isolation for untrusted CI**, **warm-start-at-zero-idle**,
  and **VPC access** — cost is a *sometimes*-win, not the headline.
- Fair alternatives to weigh: **CodeBuild-hosted GitHub runners** and **ARC on EKS**, not only GitHub-hosted.
