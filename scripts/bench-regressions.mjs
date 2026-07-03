import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const SCENARIOS = [
  {
    name: "split-spiral-explicit",
    timeoutMs: 90_000,
    url:
      "/?re=-1.94334108595410721892173532874847679406422394787482934904954598422259622163224872066988987e0&im=-1.77526745525298073600985160026584089058593093504515226882405914833836226903119316040932264e-11&scale=1.78021503476197481168544232833382026290505412168056081207222800545120884255997428428752374e9&iter=1105",
    requirements: {
      stable: true,
      maxStableMs: 90_000,
      maxTotalTiles: 999,
      maxRefs: 1199,
      maxOnePixelTiles: 0
    },
    baselineComparable: false
  },
  {
    name: "adaptive-minibrot-no-iter",
    timeoutMs: 60_000,
    url:
      "/?re=-1.86218386106848814866255662032946766557147909268160285449153596892015358185587196752405928e0&im=-8.91958180579457042174917493448619417836512436679850805730351156013941456934818546457269994e-19&scale=4.09038297932601834386390656422009272275389505396597529784561331345048745338146708772415699e16",
    requirements: {
      stable: true,
      maxStableMs: 60_000,
      minHudIter: 6000
    },
    baselineComparable: false
  },
  {
    name: "explicit-minibrot-low-iter",
    timeoutMs: 20_000,
    url:
      "/?re=-1.86218386106848814866255662032946766557147909268160285449153596892015358185587196752405928e0&im=-8.91958180579457042174917493448619417836512436679850805730351156013941456934818546457269994e-19&scale=4.09038297932601834386390656422009272275389505396597529784561331345048745338146708772415699e16&iter=1576",
    requirements: {
      stable: true,
      maxStableMs: 20_000,
      exactHudIter: 1576
    },
    baselineComparable: false
  },
  {
    name: "auto-iter-spiral-zoom",
    timeoutMs: 90_000,
    url:
      "/?re=-1.62435019809546661070130019418231791153586270765513841889153748878747854609210523965333931e0&im=-8.70990139262991039797754745425909141471890180110054912433964752401916327424577690764088027e-6&scale=8.86316876451934830810292246958438816831789504029136970599989761034201331636675547812932958e7",
    interaction: "zoom",
    postInteractionStable: true,
    requirements: {
      stable: true,
      maxHudIter: 5000,
      maxIterChangedAfterFinal: 0
    },
    baselineComparable: false
  },
  {
    name: "auto-iter-zoom-out-reset",
    timeoutMs: 90_000,
    url:
      "/?re=-1.86218386106848814866255662032946766557147909268160285449153596892015358185587196752405928e0&im=-8.91958180579457042174917493448619417836512436679850805730351156013941456934818546457269994e-19&scale=4.09038297932601834386390656422009272275389505396597529784561331345048745338146708772415699e16",
    interaction: "zoom-out",
    postInteractionStable: true,
    requirements: {
      stable: true,
      maxHudIter: 5000
    },
    baselineComparable: false
  },
  {
    name: "interactive-deep-pan",
    timeoutMs: 180_000,
    url: undefined,
    interaction: "pan",
    requirements: {
      stable: true,
      maxFirstVisualChangeMs: 100,
      maxNewRevisionQueuedMs: 100,
      maxFirstNewTileDoneMs: 1000,
      maxOldRevisionTileDoneAfterInput: 0
    },
    baselineComparable: false
  },
  {
    name: "interactive-deep-zoom",
    timeoutMs: 180_000,
    url: undefined,
    interaction: "zoom",
    requirements: {
      stable: true,
      maxFirstVisualChangeMs: 100,
      maxNewRevisionQueuedMs: 100,
      maxFirstNewTileDoneMs: 1000,
      maxOldRevisionTileDoneAfterInput: 0,
      maxIterProbeFastDoneMs: 180,
      maxIterChangedAfterFinal: 0
    },
    baselineComparable: false
  },
  {
    name: "deep-button-probe",
    timeoutMs: 180_000,
    url: undefined,
    requirements: {
      stable: true,
      minIterProbeFastDoneCount: 1
    },
    baselineComparable: false
  },
  {
    name: "deep-button-baseline",
    timeoutMs: 180_000,
    url: undefined,
    requirements: {
      stable: true
    },
    baselineComparable: true
  }
];

const options = parseArgs(process.argv.slice(2));
const selected = selectScenarios(options.scenarios);
const baseline = options.baselinePath ? await readBaseline(options.baselinePath) : undefined;
const results = [];

let port = options.port;
for (const scenario of selected) {
  const raw = await runDeepViewBench(scenario, port);
  port += 1;
  const metrics = projectMetrics(scenario, raw);
  const failures = [
    ...checkRequirements(scenario.requirements, metrics),
    ...checkBaseline(scenario, metrics, baseline?.[scenario.name])
  ];
  results.push({
    name: scenario.name,
    ...metrics,
    pass: failures.length === 0,
    failures
  });
}

const output = {
  generatedAt: new Date().toISOString(),
  scenarios: results,
  passed: results.every((result) => result.pass)
};

if (options.writeBaselinePath) {
  await writeJson(options.writeBaselinePath, {
    generatedAt: output.generatedAt,
    scenarios: Object.fromEntries(results.map((result) => [result.name, baselineMetrics(result)]))
  });
}

console.log(JSON.stringify(output, null, 2));
process.exitCode = output.passed ? 0 : 1;

function parseArgs(args) {
  const parsed = {
    scenarios: [],
    baselinePath: undefined,
    writeBaselinePath: undefined,
    port: 4173
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--scenario") {
      parsed.scenarios.push(...args[++index].split(","));
    } else if (arg.startsWith("--scenario=")) {
      parsed.scenarios.push(...arg.slice("--scenario=".length).split(","));
    } else if (arg === "--baseline") {
      parsed.baselinePath = args[++index];
    } else if (arg.startsWith("--baseline=")) {
      parsed.baselinePath = arg.slice("--baseline=".length);
    } else if (arg === "--write-baseline") {
      parsed.writeBaselinePath = args[++index];
    } else if (arg.startsWith("--write-baseline=")) {
      parsed.writeBaselinePath = arg.slice("--write-baseline=".length);
    } else if (arg === "--port") {
      parsed.port = Number(args[++index]);
    } else if (arg.startsWith("--port=")) {
      parsed.port = Number(arg.slice("--port=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(parsed.port) || parsed.port <= 0) throw new Error("--port must be a positive number");
  return parsed;
}

function selectScenarios(names) {
  if (names.length === 0) return SCENARIOS.filter((scenario) => !scenario.baselineComparable);
  const wanted = new Set(names.map((name) => name.trim()).filter(Boolean));
  if (wanted.has("all")) return SCENARIOS;
  const selected = SCENARIOS.filter((scenario) => wanted.has(scenario.name));
  const selectedNames = new Set(selected.map((scenario) => scenario.name));
  for (const name of wanted) {
    if (!selectedNames.has(name)) throw new Error(`Unknown scenario: ${name}`);
  }
  return selected;
}

function runDeepViewBench(scenario, port) {
  const args = ["scripts/bench-deep-view.mjs", "--timeout-ms", String(scenario.timeoutMs), "--port", String(port)];
  if (scenario.url !== undefined) args.push("--url", scenario.url);
  if (scenario.interaction !== undefined) args.push("--interaction", scenario.interaction);
  if (scenario.postInteractionStable) args.push("--post-interaction-stable");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", () => {
      try {
        const parsed = JSON.parse(stdout.slice(stdout.indexOf("{")));
        resolve({ ...parsed, childStderr: stderr.trim() });
      } catch (error) {
        reject(new Error(`Failed to parse bench output for ${scenario.name}: ${error instanceof Error ? error.message : String(error)}\n${stderr}`));
      }
    });
  });
}

function projectMetrics(scenario, raw) {
  const regression = raw.regression ?? {};
  return {
    stableMs: regression.stableMs ?? raw.stableMs ?? null,
    stable: Boolean(raw.stable),
    tileDone: regression.tileDone ?? raw.counts?.tileDone ?? 0,
    finalCount: regression.finalCount ?? raw.counts?.final ?? 0,
    exactCount: regression.exactCount ?? raw.counts?.exact ?? 0,
    previewCount: regression.previewCount ?? raw.counts?.preview ?? 0,
    referenceDone: regression.referenceDone ?? raw.counts?.referenceDone ?? 0,
    totalTiles: regression.totalTiles ?? parseTileProgress(raw.hud?.tiles).total,
    maxActiveTiles: regression.maxActiveTiles ?? parseTileProgress(raw.hud?.tiles).total,
    refs: regression.refs ?? (Number(raw.hud?.refs) || 0),
    p50WorkerMs: regression.p50WorkerMs ?? raw.percentiles?.finalWorkerMs?.p50 ?? 0,
    p95WorkerMs: regression.p95WorkerMs ?? raw.percentiles?.finalWorkerMs?.p95 ?? 0,
    exactFallbackPixels: regression.exactFallbackPixels ?? raw.waves?.exactFallbackPixels ?? 0,
    unresolvedFinals: regression.unresolvedFinals ?? raw.waves?.unresolvedFinals ?? 0,
    onePixelTiles: regression.onePixelTiles ?? raw.waves?.onePixelTiles ?? 0,
    hudIter: Number(raw.hud?.iter) || 0,
    hudTiles: raw.hud?.tiles ?? "",
    firstVisualChangeMs: raw.interactive?.firstVisualChangeMs ?? null,
    newRevisionQueuedMs: raw.interactive?.newRevisionQueuedMs ?? null,
    firstNewTileDoneMs: raw.interactive?.firstNewTileDoneMs ?? null,
    oldRevisionTileDoneAfterInput: raw.interactive?.oldRevisionTileDoneAfterInput ?? 0,
    iterProbeFastDoneMs: raw.interactive?.iterProbeFastDoneMs ?? regression.iterProbeFastDoneMs ?? raw.probe?.firstFastDoneMs ?? null,
    iterProbeFastDoneCount: regression.iterProbeFastDoneCount ?? raw.probe?.fastDoneCount ?? 0,
    iterChangedBeforeFinal: regression.iterChangedBeforeFinal ?? raw.probe?.iterChangedBeforeFinal ?? 0,
    iterChangedAfterFinal: raw.interactive?.iterChangedAfterFinal ?? regression.iterChangedAfterFinal ?? raw.probe?.iterChangedAfterFinal ?? 0,
    renderIterIncreaseCount: regression.renderIterIncreaseCount ?? raw.renderIter?.increaseCount ?? 0,
    renderIterDecreaseCount: regression.renderIterDecreaseCount ?? raw.renderIter?.decreaseCount ?? 0,
    seedProbeConfirmedClusters: regression.seedProbeConfirmedClusters ?? raw.probe?.firstFastConfirmedClusters ?? 0,
    capHitBoundaryPixels: regression.capHitBoundaryPixels ?? raw.renderIter?.capHitBoundaryPixels ?? 0,
    nearCapEscapedPixels: regression.nearCapEscapedPixels ?? raw.renderIter?.nearCapEscapedPixels ?? 0,
    scenario: scenario.name
  };
}

function checkRequirements(requirements, metrics) {
  const failures = [];
  if (!requirements) return failures;
  if (requirements.stable && !metrics.stable) failures.push("did not reach stable");
  if (requirements.maxStableMs !== undefined && (metrics.stableMs === null || metrics.stableMs > requirements.maxStableMs)) {
    failures.push(`stableMs ${metrics.stableMs} > ${requirements.maxStableMs}`);
  }
  if (requirements.maxTotalTiles !== undefined && metrics.totalTiles > requirements.maxTotalTiles) {
    failures.push(`totalTiles ${metrics.totalTiles} > ${requirements.maxTotalTiles}`);
  }
  if (requirements.maxRefs !== undefined && metrics.refs > requirements.maxRefs) failures.push(`refs ${metrics.refs} > ${requirements.maxRefs}`);
  if (requirements.maxOnePixelTiles !== undefined && metrics.onePixelTiles > requirements.maxOnePixelTiles) {
    failures.push(`onePixelTiles ${metrics.onePixelTiles} > ${requirements.maxOnePixelTiles}`);
  }
  if (requirements.minHudIter !== undefined && metrics.hudIter < requirements.minHudIter) {
    failures.push(`hudIter ${metrics.hudIter} < ${requirements.minHudIter}`);
  }
  if (requirements.exactHudIter !== undefined && metrics.hudIter !== requirements.exactHudIter) {
    failures.push(`hudIter ${metrics.hudIter} !== ${requirements.exactHudIter}`);
  }
  if (requirements.maxHudIter !== undefined && metrics.hudIter > requirements.maxHudIter) {
    failures.push(`hudIter ${metrics.hudIter} > ${requirements.maxHudIter}`);
  }
  if (requirements.maxFirstVisualChangeMs !== undefined && (metrics.firstVisualChangeMs === null || metrics.firstVisualChangeMs > requirements.maxFirstVisualChangeMs)) {
    failures.push(`firstVisualChangeMs ${metrics.firstVisualChangeMs} > ${requirements.maxFirstVisualChangeMs}`);
  }
  if (requirements.maxNewRevisionQueuedMs !== undefined && (metrics.newRevisionQueuedMs === null || metrics.newRevisionQueuedMs > requirements.maxNewRevisionQueuedMs)) {
    failures.push(`newRevisionQueuedMs ${metrics.newRevisionQueuedMs} > ${requirements.maxNewRevisionQueuedMs}`);
  }
  if (requirements.maxFirstNewTileDoneMs !== undefined && (metrics.firstNewTileDoneMs === null || metrics.firstNewTileDoneMs > requirements.maxFirstNewTileDoneMs)) {
    failures.push(`firstNewTileDoneMs ${metrics.firstNewTileDoneMs} > ${requirements.maxFirstNewTileDoneMs}`);
  }
  if (requirements.maxOldRevisionTileDoneAfterInput !== undefined && metrics.oldRevisionTileDoneAfterInput > requirements.maxOldRevisionTileDoneAfterInput) {
    failures.push(`oldRevisionTileDoneAfterInput ${metrics.oldRevisionTileDoneAfterInput} > ${requirements.maxOldRevisionTileDoneAfterInput}`);
  }
  if (requirements.maxIterProbeFastDoneMs !== undefined && (metrics.iterProbeFastDoneMs === null || metrics.iterProbeFastDoneMs > requirements.maxIterProbeFastDoneMs)) {
    failures.push(`iterProbeFastDoneMs ${metrics.iterProbeFastDoneMs} > ${requirements.maxIterProbeFastDoneMs}`);
  }
  if (requirements.minIterProbeFastDoneCount !== undefined && metrics.iterProbeFastDoneCount < requirements.minIterProbeFastDoneCount) {
    failures.push(`iterProbeFastDoneCount ${metrics.iterProbeFastDoneCount} < ${requirements.minIterProbeFastDoneCount}`);
  }
  if (requirements.maxIterChangedAfterFinal !== undefined && metrics.iterChangedAfterFinal > requirements.maxIterChangedAfterFinal) {
    failures.push(`iterChangedAfterFinal ${metrics.iterChangedAfterFinal} > ${requirements.maxIterChangedAfterFinal}`);
  }
  return failures;
}

function checkBaseline(scenario, metrics, baseline) {
  if (!scenario.baselineComparable || !baseline || !metrics.stable || metrics.stableMs === null) return [];
  const failures = [];
  const stableLimit = Math.max(baseline.stableMs * 1.1, baseline.stableMs + 2000);
  if (metrics.stableMs > stableLimit) failures.push(`stableMs ${metrics.stableMs} > baseline limit ${Math.round(stableLimit)}`);
  const p95Limit = baseline.p95WorkerMs * 1.15;
  if (baseline.p95WorkerMs > 0 && metrics.p95WorkerMs > p95Limit) {
    failures.push(`p95WorkerMs ${metrics.p95WorkerMs} > baseline limit ${Math.round(p95Limit)}`);
  }
  return failures;
}

async function readBaseline(path) {
  const raw = JSON.parse(await readFile(path, "utf8"));
  return raw.scenarios ?? raw;
}

function baselineMetrics(result) {
  return {
    stableMs: result.stableMs,
    p95WorkerMs: result.p95WorkerMs,
    p50WorkerMs: result.p50WorkerMs,
    tileDone: result.tileDone,
    finalCount: result.finalCount,
    previewCount: result.previewCount,
    referenceDone: result.referenceDone,
    totalTiles: result.totalTiles,
    refs: result.refs,
    firstVisualChangeMs: result.firstVisualChangeMs,
    newRevisionQueuedMs: result.newRevisionQueuedMs,
    firstNewTileDoneMs: result.firstNewTileDoneMs,
    iterProbeFastDoneMs: result.iterProbeFastDoneMs,
    iterChangedAfterFinal: result.iterChangedAfterFinal,
    renderIterIncreaseCount: result.renderIterIncreaseCount,
    renderIterDecreaseCount: result.renderIterDecreaseCount
  };
}

async function writeJson(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function parseTileProgress(value) {
  const match = /^(\d+)\/(\d+)$/.exec(String(value ?? "").trim());
  return {
    completed: match ? Number(match[1]) : 0,
    total: match ? Number(match[2]) : 0
  };
}
