import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import init, {
  compute_reference,
  compute_reference_3mul,
  compute_reference_no_escape_check,
  compute_reference_sparse,
  direct_escape
} from "../src/wasm/pkg/mandelbrot_wasm.js";

const wasmPath = new URL("../src/wasm/pkg/mandelbrot_wasm_bg.wasm", import.meta.url);
const wasm = readFileSync(wasmPath);
await init({ module_or_path: wasm });

const branch = exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "unknown";
const commit = exec("git", ["rev-parse", "--short", "HEAD"]) ?? "unknown";
const wasmBytes = statSync(wasmPath).size;

const cases = [
  {
    name: "shallow-128",
    re: "3e-1",
    im: "5e-1",
    maxIter: 128,
    bits: 128,
    reps: 20
  },
  {
    name: "1e100-512",
    re: "-7.43643887037158704752191506114774e-1",
    im: "1.31825904205311970493132056385139e-1",
    maxIter: 6912,
    bits: 512,
    reps: 8
  },
  {
    name: "e79-768",
    re: "-7.4688394343169276054191953271440985923260663988633375070109254116564380822428781e-1",
    im: "-1.0052598241121587675259369892011437164151107429135698306788524375078819321907888e-1",
    maxIter: 5601,
    bits: 768,
    reps: 8
  },
  {
    name: "20k-512",
    re: "-7.43643887037158704752191506114774e-1",
    im: "1.31825904205311970493132056385139e-1",
    maxIter: 20_000,
    bits: 512,
    reps: 4
  },
  {
    name: "false-disk-4096",
    re: "4.3792424135946285718646361930043170565329095266291420488816260206742136590487596e-1",
    im: "3.4189208433811610894511184773165189135789717878674952119590075744029026125433273e-1",
    maxIter: 2243,
    bits: 4096,
    reps: 6
  }
];

const algorithms = [
  {
    name: "3mul",
    run: (testCase) => compute_reference_3mul(testCase.re, testCase.im, testCase.maxIter, testCase.bits),
    validate: true
  },
  {
    name: "sparse8",
    run: (testCase) => compute_reference_sparse(testCase.re, testCase.im, testCase.maxIter, testCase.bits, 8),
    validate: true
  },
  {
    name: "sparse16",
    run: (testCase) => compute_reference(testCase.re, testCase.im, testCase.maxIter, testCase.bits),
    validate: true
  },
  {
    name: "sparse32",
    run: (testCase) => compute_reference_sparse(testCase.re, testCase.im, testCase.maxIter, testCase.bits, 32),
    validate: true
  },
  {
    name: "2mul-no-check",
    run: (testCase) => compute_reference_no_escape_check(testCase.re, testCase.im, testCase.maxIter, testCase.bits),
    validate: false
  }
];

console.log(`branch=${branch} commit=${commit} wasm_bytes=${wasmBytes}`);
console.log("case\talgorithm\tavg_ms\tmin_ms\tmax_ms\tescaped\torbit_len\tok");

for (const testCase of cases) {
  const expected = direct_escape(testCase.re, testCase.im, testCase.maxIter, testCase.bits);

  for (const algorithm of algorithms) {
    algorithm.run(testCase);
    const samples = [];
    let result;

    for (let i = 0; i < testCase.reps; i += 1) {
      const start = performance.now();
      result = algorithm.run(testCase);
      samples.push(performance.now() - start);
    }

    const avg = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    const orbitLen = result.orbit_re?.length ?? 0;
    const ok = algorithm.validate ? result.escaped_at === expected && orbitLen === Math.min(testCase.maxIter, result.escaped_at) + 1 : "upper";

    console.log(
      [
        testCase.name,
        algorithm.name,
        avg.toFixed(2),
        min.toFixed(2),
        max.toFixed(2),
        result.escaped_at,
        orbitLen,
        ok
      ].join("\t")
    );
  }
}

function exec(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}
