import { loadGateMem, turnsAsOf, writePredictionsJsonl, checkCoverage, episodesById } from "swarmkit-eval";
const fns = { loadGateMem, turnsAsOf, writePredictionsJsonl, checkCoverage, episodesById };
console.log("imports OK:", Object.entries(fns).every(([, f]) => typeof f === "function"));
const GM = process.env.GATEMEM_DIR!;
const d = loadGateMem(`${GM}/bench/data/medical`);
console.log(`medical: episodes=${d.episodes.length} queries=${d.queries.length} answerKey=${d.answerKey.size}`);
