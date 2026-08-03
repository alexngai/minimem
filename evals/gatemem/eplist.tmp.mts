import { loadGateMem, queriesByEpisode } from "swarmkit-eval";
const d = loadGateMem(process.env.GM + "/bench/data/medical");
const ids = [...queriesByEpisode(d.queries).keys()].sort();
ids.forEach((id, i) => { if (i >= 13 && i <= 15) console.log(`  [${i}] ${id}`); });
