/** Full Minimem lifecycle per iteration (what each pilot episode does), watching fd count. */
import fsp from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { Minimem, serializeFrontmatter } from "../../src/index.js";

const N = Number(process.argv[2] ?? "20");
const root = "/tmp/mm-fd-test";
const fds = () => {
  try { return execSync(`lsof -p ${process.pid} 2>/dev/null | wc -l`).toString().trim(); }
  catch { return "?"; }
};
console.log(`start fds=${fds()}`);
for (let i = 1; i <= N; i++) {
  const dir = path.join(root, `ep${i}`);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(path.join(dir, "memory"), { recursive: true });
  await fsp.writeFile(path.join(dir, "MEMORY.md"), `# ep${i}\n`, "utf8");
  for (let n = 0; n < 8; n++) {
    await fsp.writeFile(
      path.join(dir, "memory", `t${n}.md`),
      `${serializeFrontmatter({ id: `t${n}`, type: "observation" })}\n\nnote ${n} in episode ${i}\n`,
      "utf8",
    );
  }
  const mm = await Minimem.create({
    memoryDir: dir, embedding: { provider: "local" },
    watch: { enabled: false }, query: { maxResults: 4, minScore: 0 },
  });
  await mm.sync({ force: true });
  await mm.search("note", { maxResults: 4, minScore: 0, skipStaleCheck: true });
  await mm.close();
  await fsp.rm(dir, { recursive: true, force: true });
  if (i % 5 === 0 || i === 1) console.log(`  iter ${i}: fds=${fds()}`);
}
await fsp.rm(root, { recursive: true, force: true });
console.log(`SURVIVED ${N} full Minimem lifecycles; end fds=${fds()}`);
