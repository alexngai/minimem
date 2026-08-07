import { loadGateMem, episodesWithoutRelationships } from "swarmkit-eval";
const d = loadGateMem(process.env.GM + "/bench/data/medical");
const bad = d.episodes.filter((e) => !Array.isArray(e.entities?.relationships));
console.log(`episodes with non-array relationships: ${bad.length} (expect 0)`);
console.log(`episodes with NO authorization edges: ${episodesWithoutRelationships(d.episodes).length} of ${d.episodes.length}`);
