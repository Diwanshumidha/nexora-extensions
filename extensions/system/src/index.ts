import * as os from "node:os";
import { Extension, s, tool } from "@nexora/extension-sdk";

const GB = 1024 ** 3;
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** Read-only facts about this machine. Uses only Node's os module: no file,
 *  network or process access. */
class System extends Extension {
  @tool({ description: "Operating system, CPU, memory and uptime of this computer.", readOnly: true })
  info() {
    const cpus = os.cpus();
    return {
      os: `${os.type()} ${os.release()}`,
      platform: os.platform(),
      arch: os.arch(),
      cpu: { model: cpus[0]?.model.trim(), cores: cpus.length, speedMHz: cpus[0]?.speed },
      memoryGB: { total: round(os.totalmem() / GB), free: round(os.freemem() / GB) },
      uptimeHours: round(os.uptime() / 3600),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
    };
  }

  @tool({ description: "Current load: memory use, CPU load averages (1/5/15 min) and CPU usage over the last second.",
    readOnly: true,
    output: s.object({ memoryUsedPercent: s.number(), loadAverage: s.array(s.number()), cpuPercent: s.number() }) })
  async usage() {
    const before = os.cpus();
    await new Promise((r) => setTimeout(r, 1000));
    const after = os.cpus();
    let idle = 0, total = 0;
    after.forEach((c, i) => {
      const a = Object.values(c.times).reduce((x, y) => x + y, 0);
      const b = Object.values(before[i].times).reduce((x, y) => x + y, 0);
      total += a - b;
      idle += c.times.idle - before[i].times.idle;
    });
    return {
      memoryUsedPercent: round(100 * (1 - os.freemem() / os.totalmem())),
      loadAverage: os.loadavg().map((n) => round(n, 2)),
      cpuPercent: total ? round(100 * (1 - idle / total)) : 0,
    };
  }

  @tool({ description: "The current date and time on this computer, with its timezone.", readOnly: true,
    output: s.object({ iso: s.string(), local: s.string(), timezone: s.string() }) })
  now() {
    const d = new Date();
    return { iso: d.toISOString(), local: d.toString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
}

System.run();
