import { expect, test } from "@playwright/test";
import { BASE_VIEW_WIDTH, TILE_SIZE } from "../../src/types";

const PERFORMANCE_BUDGET_MS = 2_500;

const REGRESSION_VIEWS = [
  {
    url:
      "/?re=-7.5357439432760979567799292092358849408631766136639749629881847491270958924729797e-1&im=4.1829098796254371047848652422265196230273460832374920810175261015280261764135947e-2&scale=2.7112638920657753457314574878835803145383223195308304348976984034375546586792402e1&iter=604",
    sampleX: 15.5 / 32,
    sampleY: 12.5 / 16
  },
  {
    url:
      "/?re=-7.549229970244027197908742917925261755751044636618703913223906199716382497449534e-1&im=5.320534885440088329282320858070240068704121711152834282354886837408395062921113e-2&scale=1.3394307643944097352319707599505029862713399693759721188427992474105938471591505e3&iter=713",
    sampleX: 0.5,
    sampleY: 0.15
  },
  {
    url:
      "/?re=-1.7195312667941079545586189454398113271069746647515813505680542504632787025805573e0&im=6.5505858903810377100204901499228868589789948177206009920848026920443700420219874e-4&scale=1.4879731724872819376827096167093147183191284045682361153628693061499318199119286e1&iter=588",
    sampleX: 624 / 1912,
    sampleY: 624 / 948
  },
  {
    url:
      "/?re=-1.7837703627058171488767894782491136871879847141256353015158193606747347767684793e0&im=5.5357063425251600676626417761698877134903352475830355358631008611595013848605954e-4&scale=2.9886740096705962489052976484705668623645989664805902945876196244325516986288952e2&iter=671",
    sampleX: 624 / 1912,
    sampleY: 336 / 948
  }
] as const;

const ALT_DEEP_PRESET = {
  re: "3.65507337176578885294026060094803596771753851886465789116904636035808374831904454685041558745129659944566525621423768578726826509334259227102568025179459338196606859e-1",
  im: "5.92476366173214971781468865486627113155901675162131546210951676040509852198816827792342255876351114213269405343861920688594863450989932441948429028708253010581298657e-1",
  scale: "1e100"
} as const;

const MICROTILE_REGRESSION_URL =
  "/?re=-1.5737407486227469252433174706063197673796016133716925506497393696303123079866005e0&im=2.3298749061632902966620424763943810032963152815290060660675502164545864497691752e-5&scale=5.166754427175971621093750355246036136162467976203352006225560442836867743195112e3&iter=750";
const DEEP_INTERIOR_REGRESSION_URL =
  "/?re=-1.5738375605512487151154265653948631632264711132220526532084658732407373266127815e0&im=-5.436641856961396284208136132163104968082086032418720386308428789634830866733822e-10&scale=1.1351152221045656587152530244486905603141464775053705184640271695455593072075544e9&iter=1092";
const FALSE_PERIODIC_INTERIOR_URL =
  "/?re=4.3792424135946285718646361930043170565329095266291420488816260206742136590487596e-1&im=3.4189208433811610894511184773165189135789717878674952119590075744029026125433273e-1&scale=1.0835064437740330620649324308790033236032009031542860476819043611262629043597067e27&iter=2243";
const REFERENCE_EXPLOSION_REGRESSION_URL =
  "/?re=-1.4844984007770583397190828833694392678094050320358041080022085134265597136975238e0&im=-1.1888756927003972876725424636547540252174013462943168696052865147067734469300689e-5&scale=5.4036493724669001296700958127360151018828249203074393236865719904836523640593173e5&iter=879";
const SHALLOW_REFERENCE_PRESSURE_URL =
  "/?re=-7.555285830155848864404330289173214045991921102938369079173868192729048678452592e-1&im=-1.1299255326048044095654679100367577109576335059729038978640756697388655423467892e-1&scale=4.2521082000062727600593870163935622685108740541205488909679304242435828818426798e1&iter=617";
const DEEP_PRECISION_TILE_ALIGNMENT_URL =
  "/?re=-7.4688394343169276054191953271440985923260663988633375070109254116564380822428781e-1&im=-1.0052598241121587675259369892011437164151107429135698306788524375078819321907888e-1&scale=3.1649373179255141123643235951764328734858585667107715296013629081580305459152227e79&iter=5601";
const DEEP_MEMORY_REGRESSION_URL =
  "/?re=-7.4688394343169276054191953271440985923260663988633375070109254116564380822428796e-1&im=-1.0052598241121587675259369892011437164151107429135698306788524375078819321907893e-1&scale=2.1270123524035260478728648392445123424166443778810410355510198092432642054827677e78&iter=5525";
const RAINBOW_NOISE_REGRESSION_URL =
  "/?re=-7.44743856455867584502971474051977658103817187893185200400939609851583632432852598231790469e-1&im=-1.35593942108114561959508453803647827165860206496504860209432696505792919260554145799490801e-1&scale=2.5723755590577444907048627502998122776921365543852726093737771835857766320092045519877944e2&iter=667";
const ANTI_ALIASING_PEPPER_REGRESSION_URL =
  "/?re=-7.47689723441669939527017253976715439192679851461831874268821803604290203278587516851291729e-1&im=-7.22121932539053588116373452229159661989232396616246710140552835347280711817029504503225198e-2&scale=1.47647815655772413738325308653033716994542630984542066793843052404878099060420525511068532e4&iter=779";
const BANDLIMIT_REPORTED_URL =
  "/?re=-1.48458330140036247637711150173056275201800398126520184731392135110206459886484778357996466e0&im=-2.59388635255443261801021498780013338816140992922161747121570167509133203590861049947497997e-11&scale=5.36190464429385541522377455367357477832895987078444543478371941540670062366744215336045641e8&iter=7000";
const EARLY_ESCAPE_COLORING_REGRESSION_URL = "/?re=-2&im=0&scale=200";
const F64_ENDPOINT_REGRESSION_VIEWS = [
  {
    name: "scale3-near",
    url: "/?re=-2.0000000000000001&im=0&scale=3e14&iter=10000"
  },
  {
    name: "scale4-near",
    url: "/?re=-2.0000000000000001&im=0&scale=4e15&iter=10000"
  },
  {
    name: "scale4-exact",
    url: "/?re=-2&im=0&scale=4e15&iter=10000"
  }
] as const;
const REFERENCE_TRANSLATION_GLITCH_VIEWS = {
  base:
    "/?re=-1.999999999999999999997722496865251610205723263864688621461471850802795099356956634910901357309140825996029399661389577551356892748e0&im=7.891588524974215555715249014515373714049880746694313785215894473057548291754182756314059836386496027274025794562877935926703781457e-56&scale=1.619259515236639561080134939673026635984902003650327369739897946785131221679441664912925939020188144206544943729378621306962757564e65",
  shifted: {
    re: "-1.999999999999999999997722496865251610205723263864688621461471850802569002932531810516739815041891241716386923560140864558598810486e0",
    im: "7.891588525057871232752434040355144352932226930162029942677918280378038721646494834199637233428125399245380141201174438955315880712e-56",
    scale: "1.619259515236639561080134939673026635984902003650327369739897946785131221679441664912925939020188144206544943729378621306962757563e65"
  }
} as const;
const GRAY_EDGE_REGRESSION_URL =
  "/?re=-1.27943732849845421883617983015056333056548550645104382141825159351044164938397038329347978e0&im=-5.63147855791696141231505724508040262456380326148232169076294081643376175182702037659590245e-2&scale=2.31557868453953676955259871388625631367299552317831244832768609325162487992078455893055703e4&iter=1500";
const PALETTE_FOOTPRINT_REGRESSION_URL =
  "/?re=-6.66946223594351220414061702075025073882181567152192831986002310059523004175864072078497634e-1&im=-4.73676488536724904191861481769138940645914771730222045140362508393748458135121359473063677e-1&scale=7.74784629252607411431486981341523433374510907407907698525079151524254606022906253914814138e1";
const BRIGHT_FIELDLINE_CONTRAST_URL =
  "/?re=3.65507337176578885294026060094803596771753851886465789116904636035328412227022685302373151064451179094515431467238368411509651774e-1&im=5.92476366173214971781468865486627113155901675162131546210951676054743401782782494892476964551347706530382782424590053437009752788e-1&scale=4.23364510013388081972378287333510313825748479033841476600173578111021294744920383704781554353193160781522705542092500275770455794e64&iter=10000";
const DARK_FIELDLINE_CONTRAST_URL =
  "/?re=-9.959092464185054883225506132210230552190949057119571362942630457064490430604163231474625569798368531e-1&im=-2.920507103490551290150186532760395758430668842892091005073382904491078494928285425130345226290424115e-1&scale=4.303900674935801695984501351181982889546308733797690837956726229236583503365453241437207169030817557e35&iter=10000";
const TILE_EDGE_STRIPE_REGRESSION_URL =
  "/?re=-7.47058923830677172637465716958601050178238459796401120563138311051740403989739537513387692e-1&im=-9.02333390881196912445043591041816477037301725271975723099794599405573445075541691219218423e-2&scale=5.95653801318458424494811292043527003967000942264323805684287564004180700059580065965587753e6";
const RETAINED_ZOOM_REGRESSION_URL =
  "/?re=3.655073371765788852940260600948035967717538518864657891169046360358083748319044546850415587451296599501781717446246424045550101697395757929738867149146694906951587112e-1&im=5.92476366173214971781468865486627113155901675162131546210951676040509852198816827792342255876351114214355530399965315622626124804616767906310619742850551578473321577e-1&scale=9.001713130052164959645281712618962642478317587779029549748404978588248904553262998280261787393564400658816650653428951595626051579660571849070736507817648557393264193e101";
const REPORTED_INTERIOR_PERFORMANCE_VIEWS = [
  "/?re=-1.1257397657301325439972230515997209520613044826021924611013993759582727462837647199843872e0&im=-2.63359294664505520032151212049212698578945273361152731968738849510276867533004652329837119e-1&scale=2.83557495047450223543249716015972746789962659367598078011974223737616687921440259198156578e3",
  "/?re=-1.12600997907991589078966883643508860863586283945543450132120638790851859625175396984211583e0&im=-2.63568831182114856578871320311966693404083840260713337021920764797237400042112179495938257e-1&scale=1.55619652783714923159368677783330267864989296425986665680680538989238710992832234279105968e3",
  "/?re=-1.24994804348634009008713229074114186140984825556477615904319367083118495401527859228143389e0&im=8.30455933847431207826151305922658218333400769507904154948862303126448066761146393258500679e-3&scale=5.40364937246687433931311901229167474670606863452761543450732353692065500910770831197666263e5"
] as const;
const REPORTED_DEEP_PERFORMANCE_VIEW =
  "/?re=-7.46883943431692760541919532714409859232606639886333750701092541165643808224287821342188522092587382149759799587046156756309863566112516698524311312263708365547443519e-1&im=-1.00525982411215876752593698920114371641511074291356983067885243750788193219078894211160534174388216978954526887172496458449660477900264112017850945405489228557321858e-1&scale=1e100";
const PERIODIC_INTERIOR_PERFORMANCE_VIEW =
  "/?re=-1.76854392069529079967435552147905380619071646671631558221721367158317146672961987405313343e0&im=-7.30078926394540958134620082008361635055501804364889844988162485821612638368665062006680955e-4&scale=5.16675442717597361866334085449662625942340146464132181028971962586112670232698885953242576e3&iter=5000";
const ALT_REPORTED_DEEP_PERFORMANCE_VIEW = `/?re=${ALT_DEEP_PRESET.re}&im=${ALT_DEEP_PRESET.im}&scale=${ALT_DEEP_PRESET.scale}`;
const REFERENCE_PRESSURE_PERFORMANCE_VIEW =
  "/?re=-1.78638467787648365419207727720547018425703939706085767725832225881685228735410418701755894e0&im=-1.87892462354318380104774042945871534747473396966114579975399303084919971138018941887528654e-2&scale=1.7258385479561780535790570974260812707442099869376129800677603403441562714056599956588571e21";
const NYQUIST_FIELDLINE_VIEWS = [
  {
    name: "problem-1",
    url: "/?re=-7.41738202839910189366677947843941538350902031852992084835612928096070951051962925170270341e-1&im=-1.63761231945507364199933991022019044049835525705543228032984176165333660441627165262145982e-1&scale=2.21406416204186707359021246876978316167308348209666105358841953452659255739600282861041614e2&iter=10000"
  },
  {
    name: "problem-2",
    url: "/?re=-7.46883943431692760541919532714409859232606639886333750701092541165643808224287821342188522092587382149759799587046156756309863566112516698524311312263708365547443519e-1&im=-1.00525982411215876752593698920114371641511074291356983067885243750788193219078894211160534174388216978954526887172496458449660477900264112017850945405489228557321858e-1&scale=1e100&iter=10000"
  },
  {
    name: "problem-3",
    url: "/?re=3.82347105149063655774373048755868711376300663251518501946954635279967635014564719241880721e-1&im=2.47990692456277820114252480366431545992387976702724278579450835216424034716161089035345723e-1&scale=2.98867400967059904889101771646361344776187295081879331047778196394800566357709466866203306e2&iter=10000"
  },
  {
    name: "problem-4",
    url: "/?re=3.78927013424713911560966988627995201145375749177541247699422222086313960388322682337450804e-1&im=2.46813892734007826529097438464947568972374146353401289506298238293673977070782618946941324e-1&scale=2.10064558942017308524002032106983986162840356757260776240080022048689795258370463221283807e3&iter=10000"
  },
  {
    name: "guard-1",
    url: "/?re=-1.67529728835576066106786943286337907902171851712283675985137992832774051379973058188186092493699e0&im=9.87220786855566942449436290068413737861532929356419545758106207595334512375161319137904085760398e-34&scale=2.50894431091404028359669994213481762817409341799448945731195496951503685257788989557723823749574e31&iter=10000"
  },
  {
    name: "guard-2",
    url: "/?re=3.65507337176578885294026060094803596771753851886465789116904636035808374831904454685041558745129659944566525621423768578726826509334259227102568025179459338196606859e-1&im=5.92476366173214971781468865486627113155901675162131546210951676040509852198816827792342255876351114213269405343861920688594863450989932441948429028708253010581298657e-1&scale=1e100&iter=10000"
  },
  {
    name: "guard-3",
    url: "/?re=-1.25485393196095154745460628138292832599326781621100880653779942495339840920278138978979803e0&im=-3.80708852437592923813856158305933042632103634455688297337156400254193656156240443535535756e-1&scale=7.74784629252607845113329688436032438920930419469497711517493823986672997982436655710671439e1&iter=10000"
  }
] as const;
const TILE_STABILITY_REGRESSION_VIEWS = [
  "/?re=-7.01387731903521223674098370590029601822238961543775804742227688464250492677780739033222047e-1&im=-3.56367439465469861709467103905413691257500903471530163501858632930155641658498130531713519e-1&scale=8.54058762526144333935599265187197755732295827821093845497191539505192936261353888372715873e2",
  "/?re=-7.01396305289865928998453850684321869304035150941346243956315387347432441546595468420334784e-1&im=-3.56337432613263393074222923575390755071214240580033626236780076918807543075060661738918592e-1&scale=8.5405876252614433393559926518719775573229582782109384549735467211689289937451832943672213e2",
  "/?re=-7.02485508327748859893342034308239792901618973010193311747252495163082235735932939989055177e-1&im=-3.56069077897478957563590466145738846539804563682882057788922289119637288451593193386773247e-1&scale=1.71542288092908036911506000078131071223401233704341709118016699422518034262720667917371947e4"
] as const;
const UNSAFE_ACCELERATION_TILE_REGRESSIONS = [
  {
    url:
      "/?re=-7.4966934496787838098731959297327082792276256276453894183802736415249648212435748e-1&im=-3.6835970065942988109940808475490090964316091450085844904438388017995897542104474e-2&scale=6.3270229281225222636256752583925066391594865119590585837604607679616921758554968e2&iter=692",
    sampleX: 1000 / 1912,
    sampleY: 500 / 948
  },
  {
    url:
      "/?re=-7.4966934496787838098731959297327082792276256276453894183834598253472297257976325e-1&im=-3.6861521736029792925609229356779358072862177412970006775043765158497834429601425e-2&scale=8.5405876252614986071100413930631932487692657156726781640555443950802640849770656e2&iter=700",
    sampleX: 1000 / 1912,
    sampleY: 110 / 948
  },
  {
    url:
      "/?re=-7.5334616440141300198402043563623536803333838622141813662066992521181596683305397e-1&im=-4.696919675440392553632571151226876300052345258551595459624481658859540695903849e-2&scale=1.0846546284082077156096591056319128446503558802465354324581765182582005442316815e5&iter=835",
    sampleX: 1008 / 1912,
    sampleY: 546 / 948
  }
] as const;

test("stops before constructing workers when WebAssembly SIMD is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    let workerConstructionCount = 0;
    class CountingWorker extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        workerConstructionCount += 1;
        super(scriptURL, options);
      }
    }
    Object.defineProperty(window, "Worker", { configurable: true, value: CountingWorker });
    Object.defineProperty(window, "__workerConstructionCount", {
      configurable: true,
      get: () => workerConstructionCount
    });
    Object.defineProperty(WebAssembly, "validate", { configurable: true, value: () => false });
  });

  await page.goto("/");
  await expect(page.locator("#readStatus")).toHaveText("unsupported: WebAssembly SIMD is required");
  expect(await page.evaluate(() => (window as typeof window & { __workerConstructionCount: number }).__workerConstructionCount)).toBe(0);
});

test("publishes stable only after the frame containing the final tile is rendered", async ({ page }) => {
  await page.addInitScript(() => {
    const events: Array<Record<string, unknown>> = [];
    (globalThis as unknown as {
      __timingEvents: Array<Record<string, unknown>>;
      __deepBenchRecord: (event: Record<string, unknown>) => void;
    }).__timingEvents = events;
    (globalThis as unknown as { __deepBenchRecord: (event: Record<string, unknown>) => void }).__deepBenchRecord =
      (event) => events.push(event);
  });
  await page.setViewportSize({ width: 320, height: 240 });
  await page.goto("/");
  await expect(page.locator("#readStatus")).toHaveText("stable", { timeout: 15_000 });

  const timing = await page.evaluate(() => {
    const events = (globalThis as unknown as { __timingEvents: Array<Record<string, unknown>> }).__timingEvents;
    const uploads = events.filter((event) => event.type === "tileUploadDone");
    const lastUpload = Math.max(...uploads.map((event) => Number(event.uploadDoneAt)));
    const frame = events.find((event) => event.type === "frameRendered" && Number(event.renderedAt) >= lastUpload);
    const stable = events.find((event) => event.type === "hudStatusPublished" && event.status === "stable");
    return { uploadCount: uploads.length, lastUpload, frameAt: Number(frame?.renderedAt), stableAt: Number(stable?.publishedAt) };
  });
  expect(timing.uploadCount).toBeGreaterThan(0);
  expect(timing.frameAt).toBeGreaterThanOrEqual(timing.lastUpload);
  expect(timing.stableAt).toBeGreaterThanOrEqual(timing.frameAt);
});

test("renders, pans, zooms, and restores URL state", async ({ page }) => {
  await page.goto("/");
  const canvas = page.locator("#fractal");
  await expect(canvas).toBeVisible();
  await waitForNonBlankCanvas(page);

  const initial = new URL(page.url());
  await page.mouse.move(420, 320);
  await page.mouse.down();
  await page.mouse.move(520, 360, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => new URL(page.url()).searchParams.get("re")).not.toBe(initial.searchParams.get("re"));

  const afterPan = new URL(page.url());
  await page.mouse.wheel(0, -600);
  await expect.poll(() => new URL(page.url()).searchParams.get("scale")).not.toBe(afterPan.searchParams.get("scale"));
  await waitForNonBlankCanvas(page);

  const beforeReload = new URL(page.url());
  await page.reload();
  await expect(page.locator("#readScale")).not.toHaveText("");
  expect(new URL(page.url()).searchParams.get("scale")).toBe(beforeReload.searchParams.get("scale"));
});

test("lets users switch between formula and fixed iteration controls", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 650 });
  await page.goto("/");
  await waitForNonBlankCanvas(page);

  await page.locator("#iterBaseInput").fill("640");
  await page.locator("#iterBaseInput").press("Enter");
  await expect(page.locator("#readIter")).toHaveText("640");
  await expect.poll(() => new URL(page.url()).searchParams.get("iterBase")).toBe("640");
  expect(new URL(page.url()).searchParams.get("iter")).toBeNull();

  await page.locator("#iterBaseReset").click();
  await expect(page.locator("#iterBaseInput")).toHaveValue("512");
  await expect(page.locator("#readIter")).toHaveText("512");
  await expect.poll(() => new URL(page.url()).searchParams.get("iterBase")).toBeNull();

  await page.locator("#iterSlopeInput").fill("96");
  await page.locator("#iterSlopeInput").press("Enter");
  await expect.poll(() => new URL(page.url()).searchParams.get("iterSlope")).toBe("96");
  await page.locator("#iterSlopeReset").click();
  await expect(page.locator("#iterSlopeInput")).toHaveValue("64");
  await expect.poll(() => new URL(page.url()).searchParams.get("iterSlope")).toBeNull();

  await page.locator("#iterCapInput").fill("12000");
  await page.locator("#iterCapInput").press("Enter");
  await expect.poll(() => new URL(page.url()).searchParams.get("iterCap")).toBe("12000");
  await page.locator("#iterCapReset").click();
  await expect(page.locator("#iterCapInput")).toHaveValue("20000");
  await expect.poll(() => new URL(page.url()).searchParams.get("iterCap")).toBeNull();

  await page.locator("#iterFixedMode").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("iter")).toBe("512");

  await page.locator("#iterFixedInput").fill("900");
  await page.locator("#iterFixedInput").press("Enter");
  await expect(page.locator("#readIter")).toHaveText("900");
  await expect.poll(() => new URL(page.url()).searchParams.get("iter")).toBe("900");

  await page.locator("#iterFixedReset").click();
  await expect(page.locator("#iterFixedInput")).toHaveValue("512");
  await expect(page.locator("#readIter")).toHaveText("512");
  await expect.poll(() => new URL(page.url()).searchParams.get("iter")).toBe("512");

  const beforeZoom = new URL(page.url());
  await page.mouse.move(450, 325);
  await page.mouse.wheel(0, -500);
  await expect.poll(() => new URL(page.url()).searchParams.get("scale")).not.toBe(beforeZoom.searchParams.get("scale"));
  await expect(page.locator("#readIter")).toHaveText("512");
  expect(new URL(page.url()).searchParams.get("iter")).toBe("512");
});

test("docks controls vertically on desktop and toggles them offscreen", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 360 });
  await page.goto("/");
  await expect(page.locator("#readStatus")).not.toHaveText("");

  const visible = await readUiLayout(page);
  expect(visible.rail.right).toBeLessThanOrEqual(900);
  expect(visible.rail.left).toBeGreaterThan(450);
  expect(visible.toolbar.top).toBeGreaterThan(visible.hud.bottom);
  expect(visible.iter.top).toBeGreaterThan(visible.toolbar.bottom);
  expect(visible.rail.scrollHeight).toBeGreaterThan(visible.rail.clientHeight);
  expect(visible.rail.scrollWidth).toBe(visible.rail.clientWidth);
  expect(visible.toggle.left).toBeGreaterThanOrEqual(0);

  await page.locator("#uiToggle").click();
  await expect(page.locator("#uiToggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#uiRail")).toHaveAttribute("aria-hidden", "true");
  expect(await page.locator("#uiRail").evaluate((element) => (element as HTMLElement).inert)).toBe(true);
  await page.waitForTimeout(260);

  const hidden = await readUiLayout(page);
  expect(hidden.rail.left).toBeGreaterThanOrEqual(hidden.viewport.width);
  expect(hidden.toggle.left).toBeGreaterThanOrEqual(0);
  expect(hidden.toggle.right).toBeGreaterThanOrEqual(hidden.viewport.width - 1);
  expect(hidden.toggle.right).toBeLessThanOrEqual(hidden.viewport.width);

  await page.locator("#uiToggle").click();
  await expect(page.locator("#uiToggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#uiRail")).toHaveAttribute("aria-hidden", "false");
});

test("docks controls horizontally on small screens and keeps them scrollable", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 760 });
  await page.goto("/");
  await expect(page.locator("#readStatus")).not.toHaveText("");

  const visible = await readUiLayout(page);
  expect(visible.rail.bottom).toBeLessThanOrEqual(760);
  expect(visible.rail.top).toBeGreaterThan(420);
  expect(visible.toolbar.left).toBeGreaterThan(visible.hud.right);
  expect(visible.iter.left).toBeGreaterThan(visible.toolbar.right);
  expect(visible.toolbar.width).toBeLessThan(120);
  expect(visible.deep.top).toBeGreaterThan(visible.home.bottom);
  expect(visible.deepAlt.top).toBeGreaterThan(visible.deep.bottom);
  expect(visible.toolbar.height).toBeLessThanOrEqual(visible.hud.height);
  expect(Math.abs(visible.hud.height - visible.iter.height)).toBeLessThanOrEqual(1);
  expect(visible.rail.scrollWidth).toBeGreaterThan(visible.rail.clientWidth);
  expect(visible.rail.scrollHeight).toBe(visible.rail.clientHeight);
  expect(visible.toggle.top).toBeGreaterThan(0);

  await page.locator("#uiToggle").click();
  await expect(page.locator("#uiToggle")).toHaveAttribute("aria-expanded", "false");
  await page.waitForTimeout(260);

  const hidden = await readUiLayout(page);
  expect(hidden.rail.top).toBeGreaterThanOrEqual(hidden.viewport.height);
  expect(hidden.toggle.top).toBeGreaterThanOrEqual(0);
  expect(hidden.toggle.bottom).toBeGreaterThanOrEqual(hidden.viewport.height - 1);
  expect(hidden.toggle.bottom).toBeLessThanOrEqual(hidden.viewport.height);

  await page.locator("#uiToggle").click();
  await expect(page.locator("#uiToggle")).toHaveAttribute("aria-expanded", "true");
  await page.locator("#deepButton").click();
  await expect(page.locator("#readStatus")).toContainText(/rendering|stable/);
  await page.locator("#deepAltButton").click();
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return `${url.searchParams.get("re")}|${url.searchParams.get("im")}|${url.searchParams.get("scale")}`;
    })
    .toBe(`${ALT_DEEP_PRESET.re}|${ALT_DEEP_PRESET.im}|${ALT_DEEP_PRESET.scale}`);
});

test("supports pinch zoom with two touch pointers", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CDP touch injection is Chromium-specific");
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/");
  const canvas = page.locator("#fractal");
  await expect(canvas).toBeVisible();
  await waitForNonBlankCanvas(page);

  const before = new URL(page.url());
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Missing canvas bounds");
  const centerX = box.x + box.width * 0.5;
  const centerY = box.y + box.height * 0.5;
  const client = await page.context().newCDPSession(page);
  const touchPoint = (id: number, x: number, y: number) => ({ id, x, y, radiusX: 1, radiusY: 1, force: 1 });

  try {
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [touchPoint(1, centerX - 50, centerY), touchPoint(2, centerX + 50, centerY)]
    });
    for (const offset of [70, 90, 110]) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [touchPoint(1, centerX - offset, centerY - 8), touchPoint(2, centerX + offset, centerY + 8)]
      });
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await client.detach();
  }

  await expect.poll(() => new URL(page.url()).searchParams.get("scale")).not.toBe(before.searchParams.get("scale"));
  await waitForNonBlankCanvas(page);
});

test("renders the reported regression views without false interior samples", async ({ page }) => {
  await page.setViewportSize({ width: 1912, height: 948 });
  for (const view of REGRESSION_VIEWS) {
    await page.goto(view.url);
    await waitForNonBlankCanvas(page, 30_000);
    await expect(page.locator("#readTiles")).toHaveText(/(\d+)\/\1/);
    const pixel = await readCanvasPixel(page, view.sampleX, view.sampleY);
    expect(pixel[3]).toBe(255);
    expect(pixel.slice(0, 3), "escaping sample must not use the certified-interior color")
      .not.toEqual([4, 8, 16]);
  }
});

test("avoids microtile explosion on the 1170x784 near-real regression view", async ({ page }) => {
  await page.setViewportSize({ width: 1170, height: 784 });
  await page.goto(MICROTILE_REGRESSION_URL);
  await waitForNonBlankCanvas(page, 45_000);
  const tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);
  expect(tileCounts.total).toBeLessThan(2500);

  for (const [x, y] of [
    [585 / 1170, 392 / 784],
    [760 / 1170, 330 / 784],
    [330 / 1170, 310 / 784],
    [30 / 1170, 330 / 784]
  ]) {
    const pixel = await readCanvasPixel(page, x, y);
    expect(pixel[3]).toBe(255);
    expect(pixel[0] + pixel[1] + pixel[2]).toBeGreaterThan(40);
  }
});

test("renders and stabilizes the 1912x948 deep interior regression view", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1912, height: 948 });
  await page.goto(DEEP_INTERIOR_REGRESSION_URL);

  await expect
    .poll(async () => {
      const tiles = await readTileCounts(page);
      return tiles.completed;
    }, { timeout: 8_000 })
    .toBeGreaterThan(0);

  await waitForNonBlankCanvas(page, 75_000);
  const tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);
  expect(tileCounts.total).toBeLessThan(2500);
  await page.waitForTimeout(3_000);
  await expect(page.locator("#readStatus")).toHaveText("stable");

  const pixel = await readCanvasPixel(page, 1700 / 1912, 700 / 948);
  expect(pixel[3]).toBe(255);
  expect(pixel, "sample must be replaced rather than left at the WebGL clear color")
    .not.toEqual([2, 2, 4, 255]);
});

test("keeps rendered deep tiles responsive during pan and zoom", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1912, height: 948 });
  await page.goto(DEEP_INTERIOR_REGRESSION_URL);
  await waitForNonBlankCanvas(page, 75_000);

  const panStart = await page.evaluate(() => performance.now());
  await page.mouse.move(956, 474);
  await page.mouse.down();
  await page.mouse.move(1256, 594, { steps: 1 });
  await page.mouse.up();
  await expect.poll(() => hasRetainedFrameAfter(page, panStart), { timeout: 500 }).toBe(true);
  await expect(page.locator("#readStatus")).not.toHaveText(/reference pan/i);

  await page.goto(DEEP_INTERIOR_REGRESSION_URL);
  await waitForNonBlankCanvas(page, 75_000);

  const zoomStart = await page.evaluate(() => performance.now());
  await page.mouse.move(956, 474);
  await page.mouse.wheel(0, -600);
  await expect.poll(() => hasRetainedFrameAfter(page, zoomStart), { timeout: 500 }).toBe(true);
  await expect(page.locator("#readStatus")).not.toHaveText(/reference zoom/i);
});

test("keeps retained zoom tiles visible until the replacement frame is complete", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1912, height: 948 });
  await page.goto(RETAINED_ZOOM_REGRESSION_URL);
  await waitForNonBlankCanvas(page, 75_000);
  await installRetainedZoomProbe(page);

  await page.mouse.move(956, 474);
  await page.mouse.wheel(0, -120);
  await expect.poll(async () => (await readRetainedZoomProbe(page)).thresholdObserved, {
    timeout: 10_000,
    intervals: [5, 10, 25]
  }).toBe(true);
  await page.screenshot({ path: "test-results/retained-zoom-transition.png", fullPage: false });

  await expect(page.locator("#readStatus")).toHaveText("stable", { timeout: 30_000 });
  const tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);
  const probe = await readRetainedZoomProbe(page);
  expect(probe.finished).toBe(true);
  expect(probe.maxClearEdgeTiles).toBe(0);
});

test("defers render work while pan and wheel zoom inputs are still changing", async ({ page }) => {
  test.setTimeout(45_000);
  await installInteractionWorkerProbe(page);
  await page.setViewportSize({ width: 1912, height: 948 });
  await page.goto("/");
  await waitForNonBlankCanvas(page, 30_000);

  const initialProbe = await readInteractionWorkerProbe(page);
  expect(initialProbe.referenceWorkers).toBe(0);
  expect(initialProbe.referenceRequests).toBe(1);
  const pan = await dispatchContinuousPan(page);
  expect(pan.renderMessagesBeforePointerUp).toBe(0);
  await expect.poll(async () => (await readInteractionWorkerProbe(page)).renderMessages.length, { timeout: 5_000 })
    .toBeGreaterThan(pan.renderMessageCountBeforeInput);
  await expect(page.locator("#readStatus")).toHaveText("stable", { timeout: 30_000 });

  const afterPanProbe = await readInteractionWorkerProbe(page);
  expect(afterPanProbe.tileWorkers).toBe(initialProbe.tileWorkers);
  expect(afterPanProbe.referenceWorkers).toBe(initialProbe.referenceWorkers);
  expect(afterPanProbe.referenceRequests).toBe(2);

  const zoom = await dispatchContinuousWheelZoom(page);
  expect(zoom.renderMessagesDuringWheel).toBe(0);
  await expect.poll(async () => (await readInteractionWorkerProbe(page)).renderMessages.length, { timeout: 5_000 })
    .toBeGreaterThan(zoom.renderMessageCountBeforeInput);
  await expect(page.locator("#readStatus")).toHaveText("stable", { timeout: 30_000 });

  const afterZoomProbe = await readInteractionWorkerProbe(page);
  expect(afterZoomProbe.tileWorkers).toBe(initialProbe.tileWorkers);
  expect(afterZoomProbe.referenceWorkers).toBe(initialProbe.referenceWorkers);
  expect(afterZoomProbe.referenceRequests).toBe(3);
});

test("does not leave false periodic disks black at 1e27", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1912, height: 948 });
  await page.goto(FALSE_PERIODIC_INTERIOR_URL);

  for (const [x, y] of [
    [1111.7 / 1912, 160.6 / 948],
    [946.3 / 1912, 817.9 / 948],
    [1233.0 / 1912, 485.5 / 948]
  ]) {
    await expect
      .poll(async () => {
        const pixel = await readCanvasPixel(page, x, y);
        return pixel[0] + pixel[1] + pixel[2];
      }, { timeout: 45_000 })
      .toBeGreaterThan(40);
  }
});

test("renders the former reference-explosion view in one tile pass", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1912, height: 948 });
  await page.goto(REFERENCE_EXPLOSION_REGRESSION_URL);
  await waitForNonBlankCanvas(page, 75_000);

  const tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);
});

test("renders the early-escape shallow view promptly", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1912, height: 948 });
  const started = Date.now();
  await page.goto(SHALLOW_REFERENCE_PRESSURE_URL);
  await waitForNonBlankCanvas(page, 30_000);
  const stableMs = Date.now() - started;

  const tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);
  expect(stableMs).toBeLessThan(20_000);
});

test("does not render unsafe accelerated tiles on the reported medium-zoom views", async ({ page }) => {
  test.setTimeout(140_000);
  await page.setViewportSize({ width: 1912, height: 948 });

  for (const view of UNSAFE_ACCELERATION_TILE_REGRESSIONS) {
    await page.goto(view.url);
    await waitForNonBlankCanvas(page, 75_000);
    const tileCounts = await readTileCounts(page);
    expect(tileCounts.completed).toBe(tileCounts.total);

    const pixel = await readCanvasPixel(page, view.sampleX, view.sampleY);
    expect(pixel[3]).toBe(255);
    expect(pixel[0] + pixel[1] + pixel[2]).toBeLessThan(30);
  }
});

test("keeps e79 deep zoom tiles aligned and avoids ArrayBuffer allocation failures", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1912, height: 948 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(DEEP_PRECISION_TILE_ALIGNMENT_URL);
  await waitForNonBlankCanvas(page, 90_000);
  let tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);
  expect(await page.locator("#readStatus").textContent()).not.toContain("Array buffer allocation failed");
  expect(pageErrors.join("\n")).not.toMatch(/Array buffer allocation failed/i);

  const seamSamples = [
    await readCanvasPixel(page, 1536 / 1912, 320 / 948),
    await readCanvasPixel(page, 1537 / 1912, 320 / 948),
    await readCanvasPixel(page, 1536 / 1912, 448 / 948),
    await readCanvasPixel(page, 1537 / 1912, 448 / 948)
  ];
  for (const pixel of seamSamples) {
    expect(pixel[3]).toBe(255);
    expect(pixel[0] + pixel[1] + pixel[2]).toBeGreaterThan(30);
  }

  await page.goto(DEEP_MEMORY_REGRESSION_URL);
  await waitForNonBlankCanvas(page, 90_000);
  tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);
  expect(await page.locator("#readStatus").textContent()).not.toContain("Array buffer allocation failed");
  expect(pageErrors.join("\n")).not.toMatch(/Array buffer allocation failed/i);
});

test("reduces rainbow speckle on the reported boundary view", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1912, height: 948 });
  await page.goto(RAINBOW_NOISE_REGRESSION_URL);
  await waitForNonBlankCanvas(page, 75_000);

  const tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);

  const speckleRatio = await readCanvasSpeckleRatio(page, { left: 420, top: 40, right: 1680, bottom: 880 });
  expect(speckleRatio).toBeLessThanOrEqual(0.05);
});

test("palette bandlimiting removes chromatic pepper noise on the reported edge view", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1912, height: 948 });
  await page.goto(ANTI_ALIASING_PEPPER_REGRESSION_URL);
  await waitForNonBlankCanvas(page, 75_000);

  const tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);

  const speckleRatio = await readCanvasSpeckleRatio(
    page,
    { left: 420, top: 40, right: 1680, bottom: 880 }
  );
  expect(speckleRatio).toBeLessThanOrEqual(0.04);
});

test("bandlimits the reported deep boundary view and emits visual artifacts", async ({ page }) => {
  test.setTimeout(120_000);
  await installInteractionWorkerProbe(page);
  await page.setViewportSize({ width: 1912, height: 948 });
  await page.goto(BANDLIMIT_REPORTED_URL);
  await waitForNonBlankCanvas(page, 90_000);

  const tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);

  const roi = { left: 520, top: 120, right: 1420, bottom: 760 };
  const speckleRatio = await readCanvasSpeckleRatio(page, roi, { includeLumaOutliers: true });
  await page.screenshot({ path: "test-results/bandlimited-reported-url.png", fullPage: false });
  await page.screenshot({
    path: "test-results/bandlimited-reported-url-center.png",
    clip: { x: roi.left, y: roi.top, width: roi.right - roi.left, height: roi.bottom - roi.top }
  });
  expect(speckleRatio).toBeLessThanOrEqual(0.08);
});

test("keeps continuous coloring smooth across the early escape boundary at Re=-2", async ({ page }) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 1912, height: 948 });
  await page.goto(EARLY_ESCAPE_COLORING_REGRESSION_URL);
  await expect(page.locator("#readStatus")).toHaveText("stable", { timeout: 15_000 });

  const tileCounts = await readTileCounts(page);
  expect(tileCounts).toEqual({ completed: 120, total: 120 });

  const discontinuity = await readCenterVerticalDiscontinuity(page);
  await page.screenshot({ path: "test-results/early-escape-coloring-full.png", fullPage: false });
  await page.screenshot({
    path: "test-results/early-escape-coloring-center.png",
    clip: { x: 756, y: 120, width: 400, height: 708 }
  });
  expect(discontinuity.anomalousRatio).toBeLessThanOrEqual(0.02);
});

test("preserves sub-ULP structure around the Re=-2 endpoint", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1912, height: 948 });

  for (const view of F64_ENDPOINT_REGRESSION_VIEWS) {
    await page.goto(view.url);
    await expect(page.locator("#readStatus")).toHaveText("stable", { timeout: 30_000 });
    expect(await readTileCounts(page)).toEqual({ completed: 120, total: 120 });
    await page.screenshot({ path: `test-results/f64-endpoint-${view.name}.png`, fullPage: false });

    if (view.name === "scale4-near") {
      const diversity = await readEndpointBandDiversity(page, 471, 1198, [430, 450, 498, 518]);
      expect(diversity.combinedUnique).toBeGreaterThanOrEqual(32);
      expect(diversity.perRowUnique.every((count) => count > 1)).toBe(true);
    }
    if (view.name === "scale3-near") {
      const boundaries = predictedEndpointF64Boundaries(1912, 3e14);
      const discontinuity = await readPredictedVerticalBoundaryDiscontinuity(page, boundaries);
      expect(discontinuity.anomalousRatio).toBeLessThanOrEqual(0.02);
    }
  }
});

test("keeps the reported deep view invariant across an exact 20x74 pixel pan", async ({ page }) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 1912, height: 948 });

  const initialStarted = Date.now();
  await page.goto(REFERENCE_TRANSLATION_GLITCH_VIEWS.base);
  const initialMetrics = await waitForStableMetrics(page, initialStarted, PERFORMANCE_BUDGET_MS);
  expect(initialMetrics.status).toBe("stable");
  expect(initialMetrics.stableMs).toBeLessThan(PERFORMANCE_BUDGET_MS);
  expect(await readTileCounts(page)).toEqual({ completed: 120, total: 120 });
  await storeReferenceTranslationBaseline(page);
  await page.screenshot({ path: "test-results/reference-translation-base.png", fullPage: false });

  const panStarted = Date.now();
  await page.mouse.move(956, 474);
  await page.mouse.down();
  await page.mouse.move(936, 400, { steps: 1 });
  await page.mouse.up();
  const expectedCoordinatePrefix = {
    re: REFERENCE_TRANSLATION_GLITCH_VIEWS.shifted.re.slice(0, -20),
    im: REFERENCE_TRANSLATION_GLITCH_VIEWS.shifted.im.slice(0, -20),
    scale: REFERENCE_TRANSLATION_GLITCH_VIEWS.shifted.scale
  };
  await expect.poll(() => {
    const url = new URL(page.url());
    return {
      re: url.searchParams.get("re")?.slice(0, -20),
      im: url.searchParams.get("im")?.slice(0, -20),
      scale: url.searchParams.get("scale")
    };
  }).toEqual(expectedCoordinatePrefix);

  const shiftedMetrics = await waitForStableMetrics(page, panStarted, PERFORMANCE_BUDGET_MS);
  expect(shiftedMetrics.status).toBe("stable");
  expect(shiftedMetrics.stableMs).toBeLessThan(PERFORMANCE_BUDGET_MS);
  expect(await readTileCounts(page)).toEqual({ completed: 120, total: 120 });
  await page.screenshot({ path: "test-results/reference-translation-shifted.png", fullPage: false });

  const difference = await readReferenceTranslationDifference(page, 20, 74);
  expect(difference.meanAbsoluteChannelDifference).toBeLessThanOrEqual(0.02);
  expect(difference.maxChannelDifference).toBeLessThanOrEqual(16);
  expect(difference.largeDifferenceRatio).toBeLessThanOrEqual(0.0001);
});

test("keeps reported minibrot geometry stable within the performance budget across tile boundaries and small view changes", async ({ page }) => {
  test.setTimeout(30_000);
  await installInteractionWorkerProbe(page);
  await page.setViewportSize({ width: 1912, height: 948 });

  for (const url of TILE_STABILITY_REGRESSION_VIEWS) {
    const started = Date.now();
    await page.goto(url);
    const metrics = await waitForStableMetrics(page, started, PERFORMANCE_BUDGET_MS);
    expect(metrics.status).toBe("stable");
    expect(metrics.stableMs).toBeLessThan(PERFORMANCE_BUDGET_MS);

    const tileCounts = await readTileCounts(page);
    expect(tileCounts.completed).toBe(tileCounts.total);
    expect(tileCounts.total).toBe(120);
    const probe = await readInteractionWorkerProbe(page);
    expect(probe.referenceRequests).toBe(1);

    const seam = await readTileSeamDiscontinuity(page, TILE_SIZE);
    expect(seam.excessRatio).toBeLessThan(0.04);
  }
});

test("keeps palette filtering localized and stable on the reported views", async ({ page }) => {
  test.setTimeout(120_000);
  await installInteractionWorkerProbe(page);
  await page.setViewportSize({ width: 1912, height: 948 });
  const roi = { left: 520, top: 120, right: 1420, bottom: 760 };
  for (const [name, url] of [
    ["palette-footprint", PALETTE_FOOTPRINT_REGRESSION_URL],
    ["gray-regression", GRAY_EDGE_REGRESSION_URL]
  ] as const) {
    await page.goto(url);
    await waitForNonBlankCanvas(page, 90_000);

    const tileCounts = await readTileCounts(page);
    expect(tileCounts.completed).toBe(tileCounts.total);

    const speckleRatio = await readCanvasSpeckleRatio(page, roi, { includeLumaOutliers: true });
    const seam = await readTileSeamDiscontinuity(page, TILE_SIZE);
    expect(speckleRatio, `${name} speckle ratio`).toBeLessThanOrEqual(0.08);
    if (name === "palette-footprint") {
      expect(seam.excessRatio, `${name} tile seam excess ratio`).toBeLessThan(0.025);
    }

    await page.screenshot({ path: `test-results/${name}-full.png`, fullPage: false });
    await page.screenshot({
      path: `test-results/${name}-center.png`,
      clip: { x: roi.left, y: roi.top, width: roi.right - roi.left, height: roi.bottom - roi.top }
    });
  }
});

test("keeps Fieldlines legible at bright and dark palette extrema", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1912, height: 948 });

  for (const [name, url, minimumP95] of [
    ["bright", BRIGHT_FIELDLINE_CONTRAST_URL, 48],
    ["dark", DARK_FIELDLINE_CONTRAST_URL, 26]
  ] as const) {
    await page.goto(url);
    await waitForNonBlankCanvas(page, 90_000);
    expect(await readTileCounts(page)).toEqual({ completed: 120, total: 120 });

    const contrast = await readCanvasPatternContrast(page, 4);
    expect(contrast.p95, `${name} Fieldline local contrast`).toBeGreaterThanOrEqual(minimumP95);
    if (name === "bright") {
      const goldCoverage = await readCanvasGoldCoverage(page);
      expect(goldCoverage, "bright Fieldline gold coverage").toBeGreaterThanOrEqual(0.06);
    }
    await page.screenshot({ path: `test-results/fieldline-contrast-${name}.png`, fullPage: false });
  }
});

test("does not draw dark horizontal tile-edge bands on the reported view", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1912, height: 948 });
  await page.goto(TILE_EDGE_STRIPE_REGRESSION_URL);
  await waitForNonBlankCanvas(page, 75_000);

  const tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);

  const seam = await readHorizontalDarkSeamScore(page, TILE_SIZE);
  await page.screenshot({ path: "test-results/tile-edge-bandlimit.png", fullPage: false });
  expect(seam.maxExcessDarkDropRatio).toBeLessThanOrEqual(0.03);
});

test("renders the seven Fractalshades fieldline views without seams or pepper noise", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1912, height: 948 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  for (const { name, url } of NYQUIST_FIELDLINE_VIEWS) {
    await page.goto(url);
    await waitForNonBlankCanvas(page, 60_000);
    const tileCounts = await readTileCounts(page);
    expect(tileCounts, `${name} tile completion`).toEqual({
      completed: tileCounts.total,
      total: tileCounts.total
    });
    expect(await page.locator("#readStatus").textContent(), `${name} status`).not.toContain("error");
    expect(await readTransparentPixelCount(page), `${name} transparent pixels`).toBe(0);

    const seam = await readTileSeamDiscontinuity(page, TILE_SIZE);
    const speckleRatio = await readCanvasSpeckleRatio(page, {
      left: 0,
      top: 0,
      right: 1912,
      bottom: 948
    });
    expect(seam.excessRatio, `${name} tile seam excess ratio`).toBeLessThanOrEqual(0.05);
    expect(speckleRatio, `${name} chromatic speckle ratio`).toBeLessThanOrEqual(0.10);
  }

  expect(pageErrors).toEqual([]);
});

test("stabilizes the reported interior-heavy views within the performance budget", async ({ page }) => {
  test.setTimeout(30_000);
  await installInteractionWorkerProbe(page);
  await page.setViewportSize({ width: 1912, height: 948 });

  for (const url of REPORTED_INTERIOR_PERFORMANCE_VIEWS) {
    const started = Date.now();
    await page.goto(url);
    await expect.poll(() => page.locator("#readStatus").textContent(), {
      message: `view did not stabilize in time: ${url}`,
      timeout: PERFORMANCE_BUDGET_MS,
      intervals: [25]
    }).toBe("stable");
    const stableMs = Date.now() - started;
    expect(stableMs).toBeLessThan(PERFORMANCE_BUDGET_MS);

    const tileCounts = await readTileCounts(page);
    expect(tileCounts.completed).toBe(tileCounts.total);
    expect(tileCounts.total).toBe(120);
    const probe = await readInteractionWorkerProbe(page);
    for (const [x, y] of [
      [0.25, 0.25],
      [0.5, 0.5],
      [0.75, 0.75]
    ] as const) {
      const pixel = await readCanvasPixel(page, x, y);
      expect(pixel[3]).toBe(255);
    }
  }
});

test("stabilizes the reported e100 deep view within the performance budget", async ({ page }) => {
  test.setTimeout(30_000);
  await installInteractionWorkerProbe(page);
  await page.setViewportSize({ width: 1912, height: 948 });

  const started = Date.now();
  await page.goto(REPORTED_DEEP_PERFORMANCE_VIEW);
  await expect.poll(() => page.locator("#readStatus").textContent(), { timeout: PERFORMANCE_BUDGET_MS, intervals: [25] }).toBe("stable");
  const stableMs = Date.now() - started;
  expect(stableMs).toBeLessThan(PERFORMANCE_BUDGET_MS);

  const tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);
  expect(tileCounts.total).toBe(120);
  const probe = await readInteractionWorkerProbe(page);
  expect(probe.referenceRequests).toBe(1);
  for (const [x, y] of [
    [0.25, 0.25],
    [0.5, 0.5],
    [0.75, 0.75]
  ] as const) {
    const pixel = await readCanvasPixel(page, x, y);
    expect(pixel[3]).toBe(255);
  }

  const roi = { left: 520, top: 40, right: 1420, bottom: 760 };
  const speckleRatio = await readCanvasSpeckleRatio(page, roi);
  const seam = await readTileSeamDiscontinuity(page, TILE_SIZE);
  expect(speckleRatio).toBeLessThanOrEqual(0.10);
  expect(seam.excessRatio).toBeLessThan(0.04);

  if (await page.locator("#uiToggle").getAttribute("aria-expanded") === "true") {
    await page.locator("#uiToggle").click();
  }
  await expect(page.locator("#uiToggle")).toHaveAttribute("aria-expanded", "false");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/e100-palette-proxy-full.png", fullPage: false });
  await page.screenshot({
    path: "test-results/e100-palette-proxy-center.png",
    clip: { x: roi.left, y: roi.top, width: roi.right - roi.left, height: roi.bottom - roi.top }
  });
});

test("stabilizes the iter=5000 periodic-interior view within the performance budget", async ({ page }) => {
  test.setTimeout(30_000);
  await installInteractionWorkerProbe(page);
  await page.setViewportSize({ width: 1912, height: 948 });

  const started = Date.now();
  await page.goto(PERIODIC_INTERIOR_PERFORMANCE_VIEW);
  await expect.poll(() => page.locator("#readStatus").textContent(), { timeout: PERFORMANCE_BUDGET_MS, intervals: [25] }).toBe("stable");
  const stableMs = Date.now() - started;
  expect(stableMs).toBeLessThan(PERFORMANCE_BUDGET_MS);

  const tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);
  expect(tileCounts.total).toBe(120);
  const probe = await readInteractionWorkerProbe(page);
  expect(probe.referenceRequests).toBe(1);
  for (const [x, y] of [
    [0.25, 0.25],
    [0.5, 0.5],
    [0.75, 0.75]
  ] as const) {
    const pixel = await readCanvasPixel(page, x, y);
    expect(pixel[3]).toBe(255);
  }
});

test("stabilizes the alternate reported e100 deep view within the performance budget", async ({ page }) => {
  test.setTimeout(30_000);
  await installInteractionWorkerProbe(page);
  await page.setViewportSize({ width: 1912, height: 948 });

  const started = Date.now();
  await page.goto(ALT_REPORTED_DEEP_PERFORMANCE_VIEW);
  await expect.poll(() => page.locator("#readStatus").textContent(), { timeout: PERFORMANCE_BUDGET_MS, intervals: [25] }).toBe("stable");
  const stableMs = Date.now() - started;
  expect(stableMs).toBeLessThan(PERFORMANCE_BUDGET_MS);

  const tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);
  expect(tileCounts.total).toBe(120);
  const probe = await readInteractionWorkerProbe(page);
  for (const [x, y] of [
    [0.25, 0.25],
    [0.5, 0.5],
    [0.75, 0.75]
  ] as const) {
    const pixel = await readCanvasPixel(page, x, y);
    expect(pixel[3]).toBe(255);
  }
});

test("stabilizes the reported former reference-pressure view within the performance budget", async ({ page }) => {
  test.setTimeout(30_000);
  await installInteractionWorkerProbe(page);
  await page.setViewportSize({ width: 1912, height: 948 });

  const started = Date.now();
  await page.goto(REFERENCE_PRESSURE_PERFORMANCE_VIEW);
  const metrics = await waitForStableMetrics(page, started, PERFORMANCE_BUDGET_MS);
  expect(metrics.status).toBe("stable");
  expect(metrics.stableMs).toBeLessThan(PERFORMANCE_BUDGET_MS);

  const tileCounts = await readTileCounts(page);
  expect(tileCounts.completed).toBe(tileCounts.total);
  expect(tileCounts.total).toBe(120);
  const probe = await readInteractionWorkerProbe(page);
  expect(probe.referenceRequests).toBe(1);
});

async function readUiLayout(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height
      };
    };
    const rail = document.querySelector<HTMLElement>("#uiRail");
    if (!rail) throw new Error("Missing #uiRail");
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rail: {
        ...rect("#uiRail"),
        clientWidth: rail.clientWidth,
        clientHeight: rail.clientHeight,
        scrollWidth: rail.scrollWidth,
        scrollHeight: rail.scrollHeight
      },
      toggle: rect("#uiToggle"),
      hud: rect(".hud"),
      toolbar: rect(".toolbar"),
      home: rect("#homeButton"),
      deep: rect("#deepButton"),
      deepAlt: rect("#deepAltButton"),
      iter: rect(".iterPanel")
    };
  });
}

async function waitForNonBlankCanvas(page: import("@playwright/test").Page, timeout = 15_000): Promise<void> {
  await expect(page.locator("#readStatus")).toHaveText("stable", { timeout });
  await expect
    .poll(async () => {
      let sum = 0;
      for (const x of [0.1, 0.25, 0.5, 0.75, 0.9]) {
        for (const y of [0.1, 0.25, 0.5, 0.75, 0.9]) {
          const pixel = await readCanvasPixel(page, x, y);
          sum += pixel[0] + pixel[1] + pixel[2];
        }
      }
      return sum;
    })
    .toBeGreaterThan(100);
}

async function readCanvasPixel(page: import("@playwright/test").Page, x: number, y: number): Promise<[number, number, number, number]> {
  return page.evaluate(
    ({ x, y }) => {
      const canvas = document.querySelector<HTMLCanvasElement>("#fractal");
      const gl = canvas?.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
      if (!canvas || !gl) return [0, 0, 0, 0] as [number, number, number, number];
      const pixel = new Uint8Array(4);
      gl.readPixels(
        Math.floor(canvas.width * x),
        Math.max(0, canvas.height - Math.floor(canvas.height * y) - 1),
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixel
      );
      return [pixel[0], pixel[1], pixel[2], pixel[3]] as [number, number, number, number];
    },
    { x, y }
  );
}

async function readCanvasPatternContrast(
  page: import("@playwright/test").Page,
  distance: number
): Promise<{ p95: number }> {
  return page.evaluate((sampleDistance) => {
    const canvas = document.querySelector<HTMLCanvasElement>("#fractal");
    const gl = canvas?.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!canvas || !gl) return { p95: 0 };

    // Keep the desktop controls out of the sample while covering both smooth
    // background regions and dense Fieldline detail throughout the viewport.
    const width = Math.floor(canvas.width * 0.75);
    const height = canvas.height;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const deltas: number[] = [];
    const offset = (x: number, y: number) => (y * width + x) * 4;
    const colorDistance = (first: number, second: number) => {
      const red = pixels[first] - pixels[second];
      const green = pixels[first + 1] - pixels[second + 1];
      const blue = pixels[first + 2] - pixels[second + 2];
      return Math.sqrt(red * red + green * green + blue * blue);
    };

    for (let y = 0; y < height - sampleDistance; y += 2) {
      for (let x = 0; x < width - sampleDistance; x += 2) {
        const current = offset(x, y);
        deltas.push(colorDistance(current, offset(x + sampleDistance, y)));
        deltas.push(colorDistance(current, offset(x, y + sampleDistance)));
      }
    }
    deltas.sort((left, right) => left - right);
    return { p95: deltas[Math.floor((deltas.length - 1) * 0.95)] ?? 0 };
  }, distance);
}

async function readCanvasGoldCoverage(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#fractal");
    const gl = canvas?.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!canvas || !gl) return 0;

    const width = Math.floor(canvas.width * 0.75);
    const height = canvas.height;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let goldPixels = 0;
    const pixelCount = width * height;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index] / 255;
      const green = pixels[index + 1] / 255;
      const blue = pixels[index + 2] / 255;
      const value = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const delta = value - minimum;
      const saturation = value > 0 ? delta / value : 0;
      if (delta <= 0 || saturation < 0.2 || value < 0.35) continue;

      let hue: number;
      if (value === red) {
        hue = ((green - blue) / delta) % 6;
      } else if (value === green) {
        hue = (blue - red) / delta + 2;
      } else {
        hue = (red - green) / delta + 4;
      }
      hue = ((hue / 6) + 1) % 1;
      if (hue >= 0.07 && hue <= 0.18) goldPixels += 1;
    }
    return goldPixels / Math.max(1, pixelCount);
  });
}

async function hasRetainedFrameAfter(page: import("@playwright/test").Page, started: number): Promise<boolean> {
  return page.evaluate((startedAt) => {
    const frame = (globalThis as unknown as {
      __mandelbrotLastRetainedFrame?: { now?: number; retainedCount?: number };
    }).__mandelbrotLastRetainedFrame;
    return typeof frame?.now === "number" && frame.now >= startedAt && (frame.retainedCount ?? 0) > 0;
  }, started);
}

interface InteractionWorkerProbe {
  tileWorkers: number;
  referenceWorkers: number;
  unknownWorkers: number;
  referenceRequests: number;
  renderMessages: Array<{ revision: number; at: number }>;
}

interface RetainedZoomProbe {
  thresholdObserved: boolean;
  finished: boolean;
  maxClearEdgeTiles: number;
  completedAtThreshold: number;
  totalAtThreshold: number;
}

async function installRetainedZoomProbe(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#fractal");
    const status = document.querySelector<HTMLElement>("#readStatus");
    const tiles = document.querySelector<HTMLElement>("#readTiles");
    const gl = canvas?.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!canvas || !status || !tiles || !gl) throw new Error("Missing retained zoom probe target");

    const probe: RetainedZoomProbe = {
      thresholdObserved: false,
      finished: false,
      maxClearEdgeTiles: 0,
      completedAtThreshold: 0,
      totalAtThreshold: 0
    };
    (globalThis as unknown as { __retainedZoomProbe?: RetainedZoomProbe }).__retainedZoomProbe = probe;
    const tileSize = 128;
    let started = false;

    const isClearPixel = (x: number, y: number): boolean => {
      const pixel = new Uint8Array(4);
      gl.readPixels(x, canvas.height - y - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return Math.abs(pixel[0] - 2) <= 1 && Math.abs(pixel[1] - 2) <= 1 && Math.abs(pixel[2] - 4) <= 1 && pixel[3] === 255;
    };

    const countClearEdgeTiles = (): number => {
      const rects = new Map<string, { x: number; y: number; width: number; height: number }>();
      const addRect = (x: number, y: number) => {
        rects.set(`${x}:${y}`, {
          x,
          y,
          width: Math.min(tileSize, canvas.width - x),
          height: Math.min(tileSize, canvas.height - y)
        });
      };
      const bottom = Math.floor((canvas.height - 1) / tileSize) * tileSize;
      const right = Math.floor((canvas.width - 1) / tileSize) * tileSize;
      for (let x = 0; x < canvas.width; x += tileSize) {
        addRect(x, 0);
        addRect(x, bottom);
      }
      for (let y = tileSize; y < bottom; y += tileSize) {
        addRect(0, y);
        addRect(right, y);
      }

      let clearTiles = 0;
      for (const rect of rects.values()) {
        const samples = [
          [0.25, 0.25],
          [0.75, 0.25],
          [0.5, 0.5],
          [0.25, 0.75],
          [0.75, 0.75]
        ];
        if (samples.every(([u, v]) => isClearPixel(
          Math.min(canvas.width - 1, Math.floor(rect.x + rect.width * u)),
          Math.min(canvas.height - 1, Math.floor(rect.y + rect.height * v))
        ))) clearTiles += 1;
      }
      return clearTiles;
    };

    const observe = () => {
      const match = /^(\d+)\/(\d+)$/.exec(tiles.textContent ?? "");
      const completed = Number(match?.[1] ?? 0);
      const total = Number(match?.[2] ?? 0);
      if (!started && status.textContent !== "stable") started = true;
      if (started && total > 0) {
        const oldPruneThreshold = Math.max(1, Math.floor(canvas.width * canvas.height / (tileSize * tileSize) * 0.7));
        if (completed >= oldPruneThreshold && completed < total) {
          probe.thresholdObserved = true;
          probe.completedAtThreshold = completed;
          probe.totalAtThreshold = total;
          probe.maxClearEdgeTiles = Math.max(probe.maxClearEdgeTiles, countClearEdgeTiles());
        }
      }
      if (started && status.textContent === "stable") {
        probe.finished = true;
        return;
      }
      window.requestAnimationFrame(observe);
    };
    window.requestAnimationFrame(observe);
  });
}

async function readRetainedZoomProbe(page: import("@playwright/test").Page): Promise<RetainedZoomProbe> {
  return page.evaluate(() => {
    const probe = (globalThis as unknown as { __retainedZoomProbe?: RetainedZoomProbe }).__retainedZoomProbe;
    if (!probe) throw new Error("Missing retained zoom probe");
    return { ...probe };
  });
}

async function installInteractionWorkerProbe(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    const originalWorker = window.Worker;
    const probe: InteractionWorkerProbe = {
      tileWorkers: 0,
      referenceWorkers: 0,
      unknownWorkers: 0,
      referenceRequests: 0,
      renderMessages: []
    };
    (globalThis as unknown as { __interactionWorkerProbe: InteractionWorkerProbe }).__interactionWorkerProbe = probe;

    const patchedWorker = function Worker(url: string | URL, options?: WorkerOptions): Worker {
      const worker = new originalWorker(url, options);
      const urlText = String(url);
      if (urlText.includes("tileWorker")) probe.tileWorkers += 1;
      else if (urlText.includes("referenceWorker")) probe.referenceWorkers += 1;
      else probe.unknownWorkers += 1;

      const postMessage = worker.postMessage.bind(worker) as (message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => void;
      worker.postMessage = ((message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
        if (message && typeof message === "object" && (message as { type?: unknown }).type === "computeReference") {
          probe.referenceRequests += 1;
        } else if (
          message &&
          typeof message === "object" &&
          (message as { type?: unknown }).type === "renderTile"
        ) {
          const renderMessage = message as { tile?: { revision?: unknown } };
          probe.renderMessages.push({
            revision: typeof renderMessage.tile?.revision === "number" ? renderMessage.tile.revision : -1,
            at: performance.now()
          });
        }
        postMessage(message, transferOrOptions);
      }) as Worker["postMessage"];

      return worker;
    } as unknown as typeof Worker;
    patchedWorker.prototype = originalWorker.prototype;
    window.Worker = patchedWorker;
  });
}

async function readInteractionWorkerProbe(page: import("@playwright/test").Page): Promise<InteractionWorkerProbe> {
  return page.evaluate(() => {
    const probe = (globalThis as unknown as { __interactionWorkerProbe?: InteractionWorkerProbe }).__interactionWorkerProbe;
    if (!probe) throw new Error("Missing interaction worker probe");
    return {
      tileWorkers: probe.tileWorkers,
      referenceWorkers: probe.referenceWorkers,
      unknownWorkers: probe.unknownWorkers,
      referenceRequests: probe.referenceRequests,
      renderMessages: [...probe.renderMessages]
    };
  });
}

async function dispatchContinuousPan(page: import("@playwright/test").Page): Promise<{
  renderMessageCountBeforeInput: number;
  renderMessagesBeforePointerUp: number;
}> {
  return page.evaluate(async () => {
    const probe = (globalThis as unknown as { __interactionWorkerProbe?: InteractionWorkerProbe }).__interactionWorkerProbe;
    const canvas = document.querySelector<HTMLCanvasElement>("#fractal");
    if (!probe || !canvas) throw new Error("Missing pan probe target");
    const rect = canvas.getBoundingClientRect();
    const startX = rect.left + rect.width * 0.25;
    const startY = rect.top + rect.height * 0.5;
    const distance = rect.width * 0.5;
    const steps = 24;
    const renderMessageCountBeforeInput = probe.renderMessages.length;
    const init = {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      buttons: 1
    };

    canvas.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: startX, clientY: startY }));
    for (let step = 1; step <= steps; step += 1) {
      canvas.dispatchEvent(new PointerEvent("pointermove", {
        ...init,
        clientX: startX + distance * step / steps,
        clientY: startY
      }));
      await new Promise((resolve) => window.setTimeout(resolve, 16));
    }

    const renderMessagesBeforePointerUp = probe.renderMessages.length - renderMessageCountBeforeInput;
    canvas.dispatchEvent(new PointerEvent("pointerup", {
      ...init,
      buttons: 0,
      clientX: startX + distance,
      clientY: startY
    }));
    return { renderMessageCountBeforeInput, renderMessagesBeforePointerUp };
  });
}

async function dispatchContinuousWheelZoom(page: import("@playwright/test").Page): Promise<{
  renderMessageCountBeforeInput: number;
  renderMessagesDuringWheel: number;
}> {
  return page.evaluate(async () => {
    const probe = (globalThis as unknown as { __interactionWorkerProbe?: InteractionWorkerProbe }).__interactionWorkerProbe;
    const canvas = document.querySelector<HTMLCanvasElement>("#fractal");
    if (!probe || !canvas) throw new Error("Missing wheel probe target");
    const rect = canvas.getBoundingClientRect();
    const clientX = rect.left + rect.width * 0.5;
    const clientY = rect.top + rect.height * 0.5;
    const renderMessageCountBeforeInput = probe.renderMessages.length;

    for (let step = 0; step < 8; step += 1) {
      canvas.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        deltaY: -180
      }));
      await new Promise((resolve) => window.setTimeout(resolve, 16));
    }

    return {
      renderMessageCountBeforeInput,
      renderMessagesDuringWheel: probe.renderMessages.length - renderMessageCountBeforeInput
    };
  });
}

async function readTileCounts(page: import("@playwright/test").Page): Promise<{ completed: number; total: number }> {
  const text = await page.locator("#readTiles").textContent();
  const match = /^(\d+)\/(\d+)$/.exec(text ?? "");
  if (!match) return { completed: 0, total: Number.POSITIVE_INFINITY };
  return { completed: Number(match[1]), total: Number(match[2]) };
}

async function waitForStableMetrics(
  page: import("@playwright/test").Page,
  started: number,
  timeoutMs: number
): Promise<{ status: string; stableMs: number }> {
  let status = "";
  while (Date.now() - started < timeoutMs) {
    status = await page.locator("#readStatus").textContent() ?? "";
    if (status === "stable") break;
    await page.waitForTimeout(25);
  }
  return { status, stableMs: Date.now() - started };
}

async function storeReferenceTranslationBaseline(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#fractal");
    const gl = canvas?.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!canvas || !gl) throw new Error("Missing reference translation baseline target");
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    (globalThis as unknown as {
      __referenceTranslationBaseline?: { width: number; height: number; pixels: Uint8Array };
    }).__referenceTranslationBaseline = { width: canvas.width, height: canvas.height, pixels };
  });
}

async function readReferenceTranslationDifference(
  page: import("@playwright/test").Page,
  shiftX: number,
  shiftY: number
): Promise<{
  meanAbsoluteChannelDifference: number;
  maxChannelDifference: number;
  largeDifferenceRatio: number;
}> {
  return page.evaluate(({ shiftX, shiftY }) => {
    const canvas = document.querySelector<HTMLCanvasElement>("#fractal");
    const gl = canvas?.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
    const baseline = (globalThis as unknown as {
      __referenceTranslationBaseline?: { width: number; height: number; pixels: Uint8Array };
    }).__referenceTranslationBaseline;
    if (!canvas || !gl || !baseline || canvas.width !== baseline.width || canvas.height !== baseline.height) {
      return {
        meanAbsoluteChannelDifference: Number.POSITIVE_INFINITY,
        maxChannelDifference: Number.POSITIVE_INFINITY,
        largeDifferenceRatio: Number.POSITIVE_INFINITY
      };
    }

    const width = canvas.width;
    const height = canvas.height;
    const current = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, current);
    const offset = (x: number, screenY: number) => ((height - 1 - screenY) * width + x) * 4;
    let totalDifference = 0;
    let maxChannelDifference = 0;
    let largeDifferenceCount = 0;
    let comparedPixels = 0;
    for (let screenY = 0; screenY < height - shiftY; screenY += 1) {
      for (let x = 0; x < width - shiftX; x += 1) {
        const before = offset(x + shiftX, screenY + shiftY);
        const after = offset(x, screenY);
        let pixelMax = 0;
        for (let channel = 0; channel < 3; channel += 1) {
          const difference = Math.abs(baseline.pixels[before + channel] - current[after + channel]);
          totalDifference += difference;
          pixelMax = Math.max(pixelMax, difference);
          maxChannelDifference = Math.max(maxChannelDifference, difference);
        }
        if (pixelMax > 8) largeDifferenceCount += 1;
        comparedPixels += 1;
      }
    }
    return {
      meanAbsoluteChannelDifference: totalDifference / Math.max(1, comparedPixels * 3),
      maxChannelDifference,
      largeDifferenceRatio: largeDifferenceCount / Math.max(1, comparedPixels)
    };
  }, { shiftX, shiftY });
}

async function readHorizontalDarkSeamScore(
  page: import("@playwright/test").Page,
  tileSize: number
): Promise<{ maxDarkDropRatio: number; maxExcessDarkDropRatio: number; row: number }> {
  return page.evaluate((tileSize) => {
    const canvas = document.querySelector<HTMLCanvasElement>("#fractal");
    const gl = canvas?.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!canvas || !gl) {
      return { maxDarkDropRatio: Number.POSITIVE_INFINITY, maxExcessDarkDropRatio: Number.POSITIVE_INFINITY, row: -1 };
    }
    const width = canvas.width;
    const height = canvas.height;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const lumaAt = (x: number, screenY: number) => {
      const y = height - 1 - screenY;
      const offset = (y * width + x) * 4;
      return 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
    };
    let maxDarkDropRatio = 0;
    let maxExcessDarkDropRatio = 0;
    let row = -1;
    const sampleRight = Math.max(1, width - 96);
    const darkDropRatioAt = (screenY: number) => {
      let darkDrops = 0;
      let compared = 0;
      for (let x = 0; x < sampleRight; x += 1) {
        const seam = lumaAt(x, screenY);
        const upper = lumaAt(x, screenY - 2);
        const lower = lumaAt(x, screenY + 2);
        const neighbor = (upper + lower) * 0.5;
        if (neighbor > 75) {
          compared += 1;
          if (seam < 45 && neighbor - seam > 55) darkDrops += 1;
        }
      }
      return darkDrops / Math.max(1, compared);
    };
    for (let screenY = tileSize; screenY < height - 2; screenY += tileSize) {
      const ratio = darkDropRatioAt(screenY);
      const control = (darkDropRatioAt(screenY - 16) + darkDropRatioAt(screenY + 16)) * 0.5;
      const excess = Math.max(0, ratio - control);
      if (ratio > maxDarkDropRatio) {
        maxDarkDropRatio = ratio;
        row = screenY;
      }
      maxExcessDarkDropRatio = Math.max(maxExcessDarkDropRatio, excess);
    }
    return { maxDarkDropRatio, maxExcessDarkDropRatio, row };
  }, tileSize);
}

async function readTransparentPixelCount(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#fractal");
    const gl = canvas?.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!canvas || !gl) return Number.POSITIVE_INFINITY;
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let transparent = 0;
    for (let offset = 3; offset < pixels.length; offset += 4) {
      if (pixels[offset] !== 255) transparent += 1;
    }
    return transparent;
  });
}

async function readTileSeamDiscontinuity(
  page: import("@playwright/test").Page,
  tileSize: number
): Promise<{ anomalousRatio: number; controlRatio: number; excessRatio: number; anomalous: number; compared: number }> {
  return page.evaluate((tileSize) => {
    const canvas = document.querySelector<HTMLCanvasElement>("#fractal");
    const gl = canvas?.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!canvas || !gl) {
      return { anomalousRatio: Number.POSITIVE_INFINITY, controlRatio: 0, excessRatio: Number.POSITIVE_INFINITY, anomalous: 0, compared: 0 };
    }
    const width = canvas.width;
    const height = canvas.height;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const offset = (x: number, screenY: number) => ((height - 1 - screenY) * width + x) * 4;
    const delta = (ax: number, ay: number, bx: number, by: number) => {
      const a = offset(ax, ay);
      const b = offset(bx, by);
      return Math.abs(pixels[a] - pixels[b]) + Math.abs(pixels[a + 1] - pixels[b + 1]) + Math.abs(pixels[a + 2] - pixels[b + 2]);
    };
    let anomalous = 0;
    let compared = 0;
    let controlAnomalous = 0;
    let controlCompared = 0;
    const isAnomalous = (seam: number, before: number, after: number) =>
      seam > 120 && seam > Math.max(before, after) * 2.5 + 30;
    const recordVertical = (lineX: number, y: number, control: boolean) => {
      const value = isAnomalous(
        delta(lineX - 1, y, lineX, y),
        delta(lineX - 2, y, lineX - 1, y),
        delta(lineX, y, lineX + 1, y)
      );
      if (control) {
        controlCompared += 1;
        if (value) controlAnomalous += 1;
      } else {
        compared += 1;
        if (value) anomalous += 1;
      }
    };
    const recordHorizontal = (x: number, lineY: number, control: boolean) => {
      const value = isAnomalous(
        delta(x, lineY - 1, x, lineY),
        delta(x, lineY - 2, x, lineY - 1),
        delta(x, lineY, x, lineY + 1)
      );
      if (control) {
        controlCompared += 1;
        if (value) controlAnomalous += 1;
      } else {
        compared += 1;
        if (value) anomalous += 1;
      }
    };
    for (let x = tileSize; x < width - 2; x += tileSize) {
      for (let y = 2; y < height - 2; y += 1) {
        recordVertical(x, y, false);
        recordVertical(x - 16, y, true);
        recordVertical(x + 16, y, true);
      }
    }
    for (let y = tileSize; y < height - 2; y += tileSize) {
      for (let x = 2; x < width - 2; x += 1) {
        recordHorizontal(x, y, false);
        recordHorizontal(x, y - 16, true);
        recordHorizontal(x, y + 16, true);
      }
    }
    const anomalousRatio = anomalous / Math.max(1, compared);
    const controlRatio = controlAnomalous / Math.max(1, controlCompared);
    return { anomalousRatio, controlRatio, excessRatio: Math.max(0, anomalousRatio - controlRatio), anomalous, compared };
  }, tileSize);
}

async function readEndpointBandDiversity(
  page: import("@playwright/test").Page,
  left: number,
  right: number,
  rows: number[]
): Promise<{ combinedUnique: number; perRowUnique: number[] }> {
  return page.evaluate(({ left, right, rows }) => {
    const canvas = document.querySelector<HTMLCanvasElement>("#fractal");
    const gl = canvas?.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!canvas || !gl) return { combinedUnique: 0, perRowUnique: [] };
    const sampleLeft = Math.max(0, Math.floor(left));
    const sampleRight = Math.min(canvas.width - 1, Math.floor(right));
    const width = Math.max(1, sampleRight - sampleLeft + 1);
    const combined = new Set<string>();
    const perRowUnique = rows.map((screenY) => {
      const pixels = new Uint8Array(width * 4);
      gl.readPixels(
        sampleLeft,
        Math.max(0, canvas.height - Math.floor(screenY) - 1),
        width,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels
      );
      const colors = new Set<string>();
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const color = `${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`;
        colors.add(color);
        combined.add(color);
      }
      return colors.size;
    });
    return { combinedUnique: combined.size, perRowUnique };
  }, { left, right, rows });
}

function predictedEndpointF64Boundaries(width: number, scale: number): number[] {
  const pixelSpan = BASE_VIEW_WIDTH / scale / width;
  const center = width * 0.5;
  const boundaries: number[] = [];
  const appendSide = (direction: -1 | 1, spacing: number) => {
    for (let step = 0; ; step += 1) {
      const boundary = center + direction * ((step + 0.5) * spacing) / pixelSpan - 0.5;
      if (boundary <= 1 || boundary >= width - 1) break;
      boundaries.push(boundary);
    }
  };
  appendSide(-1, Number.EPSILON * 2);
  appendSide(1, Number.EPSILON);
  return boundaries.sort((left, right) => left - right);
}

async function readPredictedVerticalBoundaryDiscontinuity(
  page: import("@playwright/test").Page,
  boundaries: number[]
): Promise<{ anomalousRatio: number; anomalous: number; compared: number }> {
  return page.evaluate((boundaries) => {
    const canvas = document.querySelector<HTMLCanvasElement>("#fractal");
    const gl = canvas?.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!canvas || !gl) return { anomalousRatio: Number.POSITIVE_INFINITY, anomalous: 0, compared: 0 };
    const width = canvas.width;
    const height = canvas.height;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const offset = (x: number, screenY: number) => ((height - 1 - screenY) * width + x) * 4;
    const delta = (lineX: number, screenY: number) => {
      const left = offset(lineX - 1, screenY);
      const right = offset(lineX, screenY);
      return (
        Math.abs(pixels[left] - pixels[right]) +
        Math.abs(pixels[left + 1] - pixels[right + 1]) +
        Math.abs(pixels[left + 2] - pixels[right + 2])
      );
    };
    let anomalous = 0;
    let compared = 0;
    for (const boundary of boundaries) {
      const lineX = Math.max(2, Math.min(width - 2, Math.round(boundary)));
      for (let screenY = 1; screenY < height - 1; screenY += 1) {
        if (Math.abs(screenY - height * 0.5) < 8) continue;
        const seam = delta(lineX, screenY);
        const before = delta(lineX - 1, screenY);
        const after = delta(lineX + 1, screenY);
        compared += 1;
        if (seam > 120 && seam > Math.max(before, after) * 2.5 + 30) anomalous += 1;
      }
    }
    return { anomalousRatio: anomalous / Math.max(1, compared), anomalous, compared };
  }, boundaries);
}

async function readCenterVerticalDiscontinuity(
  page: import("@playwright/test").Page
): Promise<{ anomalousRatio: number; anomalous: number; compared: number; maxDelta: number }> {
  const screenshot = await page.locator("#fractal").screenshot({ type: "png" });
  return page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const scratch = document.createElement("canvas");
    scratch.width = image.naturalWidth;
    scratch.height = image.naturalHeight;
    const context = scratch.getContext("2d", { willReadFrequently: true });
    if (!context) return { anomalousRatio: Number.POSITIVE_INFINITY, anomalous: 0, compared: 0, maxDelta: 0 };
    context.drawImage(image, 0, 0);
    const width = scratch.width;
    const height = scratch.height;
    const pixels = context.getImageData(0, 0, width, height).data;
    const centerX = Math.floor(width * 0.5);
    const offset = (x: number, screenY: number) => (screenY * width + x) * 4;
    const delta = (leftX: number, screenY: number) => {
      const left = offset(leftX, screenY);
      const right = offset(leftX + 1, screenY);
      return (
        Math.abs(pixels[left] - pixels[right]) +
        Math.abs(pixels[left + 1] - pixels[right + 1]) +
        Math.abs(pixels[left + 2] - pixels[right + 2])
      );
    };

    let anomalous = 0;
    let compared = 0;
    let maxDelta = 0;
    for (let y = 1; y < height - 1; y += 1) {
      // The real axis is a genuine high-contrast feature; the regression is the
      // otherwise full-height vertical discontinuity through the view center.
      if (Math.abs(y - height * 0.5) < 6) continue;
      const seam = delta(centerX - 1, y);
      const before = delta(centerX - 2, y);
      const after = delta(centerX, y);
      maxDelta = Math.max(maxDelta, seam);
      compared += 1;
      if (seam > 120 && seam > Math.max(before, after) * 2.5 + 30) anomalous += 1;
    }

    return { anomalousRatio: anomalous / Math.max(1, compared), anomalous, compared, maxDelta };
  }, `data:image/png;base64,${screenshot.toString("base64")}`);
}

async function readCanvasSpeckleRatio(
  page: import("@playwright/test").Page,
  roi: { left: number; top: number; right: number; bottom: number },
  options: { includeLumaOutliers?: boolean } = {}
): Promise<number> {
  return page.evaluate(({ roi, includeLumaOutliers }) => {
    const canvas = document.querySelector<HTMLCanvasElement>("#fractal");
    const gl = canvas?.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!canvas || !gl) return Number.POSITIVE_INFINITY;
    const left = Math.max(0, Math.floor(roi.left));
    const top = Math.max(0, Math.floor(roi.top));
    const right = Math.min(canvas.width, Math.floor(roi.right));
    const bottom = Math.min(canvas.height, Math.floor(roi.bottom));
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(left, canvas.height - bottom, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let total = 0;
    let speckles = 0;
    const pixelOffset = (x: number, y: number) => (y * width + x) * 4;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const offset = pixelOffset(x, y);
        const red = pixels[offset];
        const green = pixels[offset + 1];
        const blue = pixels[offset + 2];
        const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
        const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
        let maxDelta = 0;
        const neighborLuma: number[] = [];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const neighbor = pixelOffset(x + dx, y + dy);
          const delta =
            Math.abs(red - pixels[neighbor]) +
            Math.abs(green - pixels[neighbor + 1]) +
            Math.abs(blue - pixels[neighbor + 2]);
          maxDelta = Math.max(maxDelta, delta);
        }
        if (includeLumaOutliers) {
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              if (dx === 0 && dy === 0) continue;
              const neighbor = pixelOffset(x + dx, y + dy);
              neighborLuma.push(
                0.2126 * pixels[neighbor] + 0.7152 * pixels[neighbor + 1] + 0.0722 * pixels[neighbor + 2]
              );
            }
          }
        }
        total += 1;
        let lumaOutlier = false;
        if (includeLumaOutliers) {
          neighborLuma.sort((a, b) => a - b);
          const medianLuma = (neighborLuma[3] + neighborLuma[4]) * 0.5;
          lumaOutlier = (luma < 45 && medianLuma > 95) || (luma > 205 && medianLuma < 85);
        }
        if ((chroma > 170 && maxDelta > 300) || lumaOutlier) speckles += 1;
      }
    }
    return speckles / Math.max(1, total);
  }, { roi, includeLumaOutliers: options.includeLumaOutliers === true });
}
