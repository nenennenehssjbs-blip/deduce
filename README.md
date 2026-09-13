# Railway Trial Benchmark

A single-file Node.js app that runs continuously, consumes a **known,
controlled** amount of CPU and RAM, and logs its own resource usage
over time — so you can see exactly how fast a trial's credit balance
drains under a given load, instead of guessing.

## Why "controlled" instead of "max everything"

Trial credits are usually billed by **resource-hours** (RAM-hours +
CPU-hours), not by "did it survive." Pegging everything to 100%
immediately just gets the process OOM-killed or throttled fast and
tells you very little. Running a **known** load (e.g. 256MB RAM,
30% CPU) for a measured number of hours tells you the actual
$/hour burn rate at that load — which you can then scale to guess
what your real project will cost.

## Deploy to Railway

1. Push this folder to a new GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo** → pick it.
3. Railway auto-detects Node via `package.json` and runs `npm start`.
4. Set env vars in Railway's dashboard (Variables tab) if you want
   non-default load levels — see below.
5. Once deployed, hit `https://<your-app>.up.railway.app/stats` any
   time to see live numbers, or check the **Deploy Logs** tab for the
   periodic JSON log lines.

## Config (all optional, set as env vars in Railway)

| Variable          | Default | Meaning                                    |
|--------------------|---------|---------------------------------------------|
| `RAM_TARGET_MB`     | 420     | MB of memory to hold onto continuously      |
| `CPU_LOAD_PCT`      | 95      | 0–100, roughly what % of one core to burn   |
| `LOG_INTERVAL_MS`   | 60000   | How often to log stats (ms)                 |

Railway sets `PORT` itself — don't override it.

Defaults above are tuned for Railway's free trial tier (1 vCPU /
0.5GB RAM per service, $5 credit / 30 days). 420MB keeps you under
the 512MB hard cap with headroom for Node's own overhead, so the
process runs continuously instead of getting OOM-killed and losing
your data mid-test. 95% CPU load pushes near the vCPU ceiling to
maximize resource-hour burn rate without permanently pegging at 100%
(which some platforms throttle harder).

## Reading the results

Every log line looks like:

```json
{"ts":"...","uptime_hours":"1.50","rss_mb":"268.3","heap_used_mb":"...","target_ram_mb":256,"cpu_load_target_pct":30,"load_avg_1m":"0.31","free_system_mem_mb":"..."}
```

Watch Railway's own **Usage** tab (shows $ consumed) alongside these
logs. After a few hours you'll have enough data points to calculate:

```
$ consumed / uptime_hours = $/hour at this RAM+CPU load
```

Then: `credit_balance / ($/hour) = hours you can run`, and you can
adjust `RAM_TARGET_MB` / `CPU_LOAD_PCT` to match what your real
project will actually need, and re-derive the number for that.

## When you're done benchmarking

Delete this service (or set `RAM_TARGET_MB=0 CPU_LOAD_PCT=0`) before
deploying your real projects — this is a synthetic load, not
something you want running alongside actual work.
