use astro_float::{BigFloat, RoundingMode, Sign};
use js_sys::{Array, Float32Array, Float64Array, Int32Array, Object, Reflect, Uint8Array, Uint8ClampedArray};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use wasm_bindgen::prelude::*;

const RM: RoundingMode = RoundingMode::ToEven;
const BASE_VIEW_WIDTH: f64 = 3.5;
const DEFAULT_REFERENCE_CHECK_INTERVAL: u32 = 16;

#[derive(Deserialize)]
struct ViewInput {
    re: String,
    im: String,
    scale: String,
    width: f64,
    height: f64,
}

#[derive(Serialize)]
struct ViewOutput {
    re: String,
    im: String,
    scale: String,
}

fn precision(bits: u32) -> usize {
    bits.clamp(96, 4096) as usize
}

fn parse_float(value: &str, bits: u32) -> Result<BigFloat, JsValue> {
    parse_decimal(value, precision(bits)).ok_or_else(|| JsValue::from_str("invalid decimal input"))
}

fn bf_from_f64(value: f64, bits: u32) -> BigFloat {
    BigFloat::from_f64(value, precision(bits))
}

fn decimal_digits(bits: u32) -> usize {
    (((bits as f64) * 0.301_029_995_663_981_2).ceil() as usize + 12).clamp(90, 1300)
}

fn bf_to_string(value: &BigFloat, digits: usize) -> String {
    if value.is_zero() {
        return "0".to_string();
    };
    let p = value.mantissa_max_bit_len().unwrap_or(256).max(256);
    let negative = value.is_negative();
    let mut normalized = if negative { value.neg() } else { value.clone() };
    let approx = bf_to_f64(&normalized).abs();
    let mut exponent = if approx.is_finite() && approx > 0.0 {
        approx.log10().floor() as i32
    } else {
        0
    };

    if exponent > 0 {
        normalized = normalized.div(&pow10(exponent as u32, p), p, RM);
    } else if exponent < 0 {
        normalized = normalized.mul(&pow10((-exponent) as u32, p), p, RM);
    }

    let ten = BigFloat::from_word(10, p);
    let one = BigFloat::from_word(1, p);
    while normalized.cmp(&ten).is_some_and(|order| order >= 0) {
        normalized = normalized.div(&ten, p, RM);
        exponent += 1;
    }
    while normalized.cmp(&one).is_some_and(|order| order < 0) {
        normalized = normalized.mul(&ten, p, RM);
        exponent -= 1;
    }

    let mut out = String::with_capacity(digits + 8);
    if negative {
        out.push('-');
    }

    let mut emitted_digits = Vec::with_capacity(digits);
    for _ in 0..digits {
        let mut digit = 0u8;
        for candidate in (0u8..=9).rev() {
            let candidate_bf = BigFloat::from_word(candidate as u64, p);
            if normalized
                .cmp(&candidate_bf)
                .is_some_and(|order| order >= 0)
            {
                digit = candidate;
                break;
            }
        }
        emitted_digits.push(digit);
        normalized = normalized
            .sub(&BigFloat::from_word(digit as u64, p), p, RM)
            .mul(&ten, p, RM);
        if normalized.is_zero() {
            break;
        }
    }

    out.push((b'0' + emitted_digits[0]) as char);
    if emitted_digits.len() > 1 {
        out.push('.');
        for digit in emitted_digits.iter().skip(1) {
            out.push((b'0' + *digit) as char);
        }
    }
    while out.ends_with('0') {
        out.pop();
    }
    if out.ends_with('.') {
        out.pop();
    }
    out.push('e');
    out.push_str(&exponent.to_string());
    out
}

fn bf_to_f64(value: &BigFloat) -> f64 {
    let Some((mantissa_words, _bits, sign, exponent, _inexact)) = value.as_raw_parts() else {
        return if value.is_negative() {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    };
    let Some(&mantissa_word) = mantissa_words.last() else {
        return 0.0;
    };
    if mantissa_word == 0 {
        return 0.0;
    }

    let mut e = exponent as isize + 0b1111111111;
    let mut bits = 0u64;
    if e >= 0b11111111111 {
        return if sign == Sign::Neg {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    if e <= 0 {
        let shift = -e;
        if shift < 52 {
            bits |= mantissa_word >> (shift + 12);
            if sign == Sign::Neg {
                bits |= 0x8000000000000000u64;
            }
            return f64::from_bits(bits);
        }
        return 0.0;
    }

    let mantissa = mantissa_word << 1;
    e -= 1;
    if sign == Sign::Neg {
        bits |= 1;
    }
    bits <<= 11;
    bits |= e as u64;
    bits <<= 52;
    bits |= mantissa >> 12;
    f64::from_bits(bits)
}

fn parse_decimal(input: &str, p: usize) -> Option<BigFloat> {
    let mut text = input.trim().to_ascii_lowercase();
    if text.is_empty() {
        return None;
    }

    let negative = text.starts_with('-');
    if text.starts_with('-') || text.starts_with('+') {
        text.remove(0);
    }

    let mut exponent = 0i32;
    let mut number_part = text.as_str();
    if let Some(index) = text.find('e') {
        number_part = &text[..index];
        exponent = text[index + 1..].parse::<i32>().ok()?;
    }

    let mut digits = String::new();
    let mut fractional_digits = 0i32;
    let mut seen_dot = false;
    for ch in number_part.chars() {
        if ch == '.' {
            if seen_dot {
                return None;
            }
            seen_dot = true;
            continue;
        }
        if !ch.is_ascii_digit() {
            return None;
        }
        if seen_dot {
            fractional_digits += 1;
        }
        digits.push(ch);
    }

    while digits.starts_with('0') && digits.len() > 1 {
        digits.remove(0);
    }
    if digits.is_empty() {
        return None;
    }

    let mut value = BigFloat::from_word(0, p);
    let ten = BigFloat::from_word(10, p);
    for ch in digits.bytes() {
        let digit = (ch - b'0') as u64;
        value = value
            .mul(&ten, p, RM)
            .add(&BigFloat::from_word(digit, p), p, RM);
    }

    let shift = exponent - fractional_digits;
    if shift > 0 {
        let factor = pow10(shift as u32, p);
        value = value.mul(&factor, p, RM);
    } else if shift < 0 {
        let factor = pow10((-shift) as u32, p);
        value = value.div(&factor, p, RM);
    }

    if negative {
        value.inv_sign();
    }
    Some(value)
}

fn pow10(exp: u32, p: usize) -> BigFloat {
    let ten = BigFloat::from_word(10, p);
    let mut value = BigFloat::from_word(1, p);
    for _ in 0..exp {
        value = value.mul(&ten, p, RM);
    }
    value
}

enum ReferenceMode {
    ThreeMul,
    TwoMulSparse { check_interval: u32 },
    TwoMulNoEscapeCheck,
}

struct OrbitResult {
    escaped_at: u32,
    orbit_re: Vec<f64>,
    orbit_im: Vec<f64>,
}

fn has_escaped(zr: &BigFloat, zi: &BigFloat, p: usize, four: &BigFloat) -> bool {
    let zr2 = zr.mul(zr, p, RM);
    let zi2 = zi.mul(zi, p, RM);
    zr2.add(&zi2, p, RM).cmp(four).is_some_and(|v| v > 0)
}

fn step_three_mul(
    zr: &BigFloat,
    zi: &BigFloat,
    cr: &BigFloat,
    ci: &BigFloat,
    p: usize,
) -> (BigFloat, BigFloat) {
    let zr2 = zr.mul(zr, p, RM);
    let zi2 = zi.mul(zi, p, RM);
    let zrzi = zr.mul(zi, p, RM);
    let next_re = zr2.sub(&zi2, p, RM).add(cr, p, RM);
    let next_im = zrzi.add(&zrzi, p, RM).add(ci, p, RM);
    (next_re, next_im)
}

fn step_two_mul(
    zr: &BigFloat,
    zi: &BigFloat,
    cr: &BigFloat,
    ci: &BigFloat,
    p: usize,
) -> (BigFloat, BigFloat) {
    let sum = zr.add(zi, p, RM);
    let diff = zr.sub(zi, p, RM);
    let next_re = sum.mul(&diff, p, RM).add(cr, p, RM);
    let zrzi = zr.mul(zi, p, RM);
    let next_im = zrzi.add(&zrzi, p, RM).add(ci, p, RM);
    (next_re, next_im)
}

fn run_reference_orbit(
    cr: &BigFloat,
    ci: &BigFloat,
    max_iter: u32,
    p: usize,
    mode: ReferenceMode,
    keep_orbit: bool,
) -> OrbitResult {
    match mode {
        ReferenceMode::ThreeMul => run_three_mul_orbit(cr, ci, max_iter, p, keep_orbit),
        ReferenceMode::TwoMulSparse { check_interval } => {
            run_two_mul_sparse_orbit(cr, ci, max_iter, p, check_interval.max(1), keep_orbit)
        }
        ReferenceMode::TwoMulNoEscapeCheck => {
            run_two_mul_no_escape_check_orbit(cr, ci, max_iter, p, keep_orbit)
        }
    }
}

fn run_three_mul_orbit(
    cr: &BigFloat,
    ci: &BigFloat,
    max_iter: u32,
    p: usize,
    keep_orbit: bool,
) -> OrbitResult {
    let mut zr = BigFloat::from_word(0, p);
    let mut zi = BigFloat::from_word(0, p);
    let four = BigFloat::from_word(4, p);
    let mut orbit_re = if keep_orbit {
        Vec::with_capacity(max_iter as usize + 1)
    } else {
        Vec::new()
    };
    let mut orbit_im = if keep_orbit {
        Vec::with_capacity(max_iter as usize + 1)
    } else {
        Vec::new()
    };
    if keep_orbit {
        orbit_re.push(0.0);
        orbit_im.push(0.0);
    }

    for i in 0..max_iter {
        if i > 0 && has_escaped(&zr, &zi, p, &four) {
            return OrbitResult {
                escaped_at: i,
                orbit_re,
                orbit_im,
            };
        }

        let (next_re, next_im) = step_three_mul(&zr, &zi, cr, ci, p);
        zr = next_re;
        zi = next_im;

        if keep_orbit {
            orbit_re.push(bf_to_f64(&zr));
            orbit_im.push(bf_to_f64(&zi));
        }
    }

    OrbitResult {
        escaped_at: max_iter,
        orbit_re,
        orbit_im,
    }
}

fn run_two_mul_no_escape_check_orbit(
    cr: &BigFloat,
    ci: &BigFloat,
    max_iter: u32,
    p: usize,
    keep_orbit: bool,
) -> OrbitResult {
    let mut zr = BigFloat::from_word(0, p);
    let mut zi = BigFloat::from_word(0, p);
    let mut orbit_re = if keep_orbit {
        Vec::with_capacity(max_iter as usize + 1)
    } else {
        Vec::new()
    };
    let mut orbit_im = if keep_orbit {
        Vec::with_capacity(max_iter as usize + 1)
    } else {
        Vec::new()
    };
    if keep_orbit {
        orbit_re.push(0.0);
        orbit_im.push(0.0);
    }

    for _ in 0..max_iter {
        let (next_re, next_im) = step_two_mul(&zr, &zi, cr, ci, p);
        zr = next_re;
        zi = next_im;

        if keep_orbit {
            orbit_re.push(bf_to_f64(&zr));
            orbit_im.push(bf_to_f64(&zi));
        }
    }

    OrbitResult {
        escaped_at: max_iter,
        orbit_re,
        orbit_im,
    }
}

fn run_two_mul_sparse_orbit(
    cr: &BigFloat,
    ci: &BigFloat,
    max_iter: u32,
    p: usize,
    check_interval: u32,
    keep_orbit: bool,
) -> OrbitResult {
    let mut zr = BigFloat::from_word(0, p);
    let mut zi = BigFloat::from_word(0, p);
    let four = BigFloat::from_word(4, p);
    let mut checkpoint_re = zr.clone();
    let mut checkpoint_im = zi.clone();
    let mut checkpoint_iter = 0u32;
    let mut orbit_re = if keep_orbit {
        Vec::with_capacity(max_iter as usize + 1)
    } else {
        Vec::new()
    };
    let mut orbit_im = if keep_orbit {
        Vec::with_capacity(max_iter as usize + 1)
    } else {
        Vec::new()
    };
    if keep_orbit {
        orbit_re.push(0.0);
        orbit_im.push(0.0);
    }

    for i in 0..max_iter {
        let next_iter = i + 1;
        let (next_re, next_im) = step_two_mul(&zr, &zi, cr, ci, p);
        zr = next_re;
        zi = next_im;

        if keep_orbit {
            orbit_re.push(bf_to_f64(&zr));
            orbit_im.push(bf_to_f64(&zi));
        }

        if next_iter % check_interval == 0 || next_iter == max_iter {
            if has_escaped(&zr, &zi, p, &four) {
                return replay_two_mul_block(
                    cr,
                    ci,
                    p,
                    &four,
                    &checkpoint_re,
                    &checkpoint_im,
                    checkpoint_iter,
                    next_iter,
                    keep_orbit,
                    orbit_re,
                    orbit_im,
                );
            }

            checkpoint_re = zr.clone();
            checkpoint_im = zi.clone();
            checkpoint_iter = next_iter;
        }
    }

    OrbitResult {
        escaped_at: max_iter,
        orbit_re,
        orbit_im,
    }
}

#[allow(clippy::too_many_arguments)]
fn replay_two_mul_block(
    cr: &BigFloat,
    ci: &BigFloat,
    p: usize,
    four: &BigFloat,
    start_re: &BigFloat,
    start_im: &BigFloat,
    start_iter: u32,
    target_iter: u32,
    keep_orbit: bool,
    mut orbit_re: Vec<f64>,
    mut orbit_im: Vec<f64>,
) -> OrbitResult {
    let mut zr = start_re.clone();
    let mut zi = start_im.clone();
    let mut iter = start_iter;

    if keep_orbit {
        let checkpoint_len = start_iter as usize + 1;
        orbit_re.truncate(checkpoint_len);
        orbit_im.truncate(checkpoint_len);
    }

    while iter < target_iter {
        let (next_re, next_im) = step_two_mul(&zr, &zi, cr, ci, p);
        zr = next_re;
        zi = next_im;
        iter += 1;

        if keep_orbit {
            orbit_re.push(bf_to_f64(&zr));
            orbit_im.push(bf_to_f64(&zi));
        }

        if has_escaped(&zr, &zi, p, four) {
            return OrbitResult {
                escaped_at: iter,
                orbit_re,
                orbit_im,
            };
        }
    }

    OrbitResult {
        escaped_at: target_iter,
        orbit_re,
        orbit_im,
    }
}

fn build_reference_value(
    center_re: &str,
    center_im: &str,
    precision_bits: u32,
    orbit: OrbitResult,
) -> Result<JsValue, JsValue> {
    let object = Object::new();
    set_js_property(&object, "center_re", &JsValue::from_str(center_re))?;
    set_js_property(&object, "center_im", &JsValue::from_str(center_im))?;
    set_js_property(
        &object,
        "precision_bits",
        &JsValue::from_f64(precision_bits as f64),
    )?;
    set_js_property(
        &object,
        "escaped_at",
        &JsValue::from_f64(orbit.escaped_at as f64),
    )?;

    let orbit_re = Float64Array::from(orbit.orbit_re.as_slice());
    let orbit_im = Float64Array::from(orbit.orbit_im.as_slice());
    set_js_property(&object, "orbit_re", orbit_re.as_ref())?;
    set_js_property(&object, "orbit_im", orbit_im.as_ref())?;

    Ok(object.into())
}

fn set_js_property(object: &Object, key: &str, value: &JsValue) -> Result<(), JsValue> {
    Reflect::set(object.as_ref(), &JsValue::from_str(key), value).map(|_| ())
}

#[derive(Clone, Copy)]
struct Rect64 {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Copy)]
struct Complex64 {
    re: f64,
    im: f64,
}

#[derive(Clone)]
struct CachedRenderReference {
    external_id: String,
    screen_x: f64,
    screen_y: f64,
    escaped_at: u32,
    max_iter: u32,
    orbit_re: Rc<Vec<f64>>,
    orbit_im: Rc<Vec<f64>>,
    interior_certificate: Option<ReferenceInteriorCertificate64>,
}

#[derive(Clone, Copy)]
struct ReferenceInteriorCertificate64 {
    radius: f64,
}

struct RenderContext {
    reference: CachedRenderReference,
    radius: f64,
    probes: Vec<Complex64>,
    series: Option<SeriesPlan64>,
}

struct SeriesPlan64 {
    skip: usize,
    degree: usize,
    coeff_re: Vec<f64>,
    coeff_im: Vec<f64>,
}

#[derive(Clone, Copy)]
struct PixelResult64 {
    iter: u32,
    mag2: f64,
    glitch: bool,
    unresolved: bool,
    failure_kind: FailureKind64,
    survived_iter: u32,
    periodic_interior: bool,
    rebase_count: u32,
    rebase_limit: bool,
    bla_skip_count: u32,
    bla_step_count: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FailureKind64 {
    None,
    EarlyReferenceEscape,
    CancellationGlitch,
    DeltaOverflow,
    RebaseLimit,
    SeriesUnsafe,
}

#[derive(Clone, Copy)]
struct PixelSelection64 {
    result: PixelResult64,
    reference_index: i32,
    skip: usize,
}

struct PeriodicScratch64 {
    checkpoint_re: [f64; 32],
    checkpoint_im: [f64; 32],
    checkpoint_iter: [u32; 32],
}

#[derive(Clone, Copy)]
struct PeriodDerivatives64 {
    z: Complex64,
    dz_dz: Complex64,
    dz_dc: Complex64,
    d_dz_dz: Complex64,
    d_dc_dz: Complex64,
}

#[derive(Clone)]
struct ClusterAccumulator64 {
    bin_x: u32,
    bin_y: u32,
    bounds: Rect64,
    count: u32,
    sum_x: f64,
    sum_y: f64,
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
    best_x: f64,
    best_y: f64,
    best_survived_iter: i32,
    best_source_reference_id: Option<String>,
    failure_kind_counts: [u32; 5],
}

#[derive(Clone)]
struct UnresolvedCluster64 {
    screen_x: f64,
    screen_y: f64,
    pixel_count: u32,
    survived_iter: u32,
    radius_px: f64,
    bin_x: u32,
    bin_y: u32,
    bounds: Rect64,
    source_reference_id: String,
    failure_kind_counts: [u32; 5],
    suggested_precision_bits: u32,
}

#[derive(Clone, Copy)]
struct Color64 {
    r: u8,
    g: u8,
    b: u8,
}

#[derive(Clone, Copy)]
struct BoundaryStats64 {
    boundary_dampened_count: u32,
    aa_pixel_count: u32,
    aa_sample_count: u32,
    aa_fallback_count: u32,
}

#[derive(Clone)]
struct RenderIterStats64 {
    escaped_iters: Vec<u32>,
    max_escaped_iter: u32,
    near_cap_escaped_count: u32,
    cap_hit_unknown_count: u32,
    cap_hit_boundary_count: u32,
}

#[derive(Clone, Copy)]
struct RenderIterSummary64 {
    max_escaped_iter: u32,
    p95_escaped_iter: u32,
    near_cap_escaped_count: u32,
    cap_hit_unknown_count: u32,
    cap_hit_boundary_count: u32,
}

#[derive(Clone, Copy)]
struct BoundaryCandidate64 {
    index: usize,
    edge_strength: f64,
    classification_change: bool,
}

#[derive(Clone, Copy)]
struct RenderEdgeInfo64 {
    edge_strength: f64,
    classification_change: bool,
}

thread_local! {
    static RENDER_REFERENCE_CACHE: RefCell<HashMap<u32, CachedRenderReference>> = RefCell::new(HashMap::new());
}

const RENDER_MIN_PIXEL_SPAN_FOR_PERIODIC_INTERIOR: f64 = 1e-18;
const RENDER_REBASE_G: f64 = 1e-8;
const RENDER_MAX_REBASES_PER_PIXEL: u32 = 64;
const RENDER_SERIES_MAX_SKIP: usize = 8192;
const RENDER_MAX_SERIES_TILE_RADIUS: f64 = 1e-3;
const RENDER_SERIES_ERROR_SCALE: f64 = 1e-7;
const RENDER_SERIES_SKIP_SATURATION: f64 = 0.7;
const RENDER_SMOOTH_DELTA_LOW: f64 = 6.0;
const RENDER_SMOOTH_DELTA_HIGH: f64 = 24.0;
const RENDER_CLASSIFICATION_EDGE_BOOST: f64 = 0.35;
const RENDER_AA_EDGE_THRESHOLD: f64 = 0.45;
const RENDER_AA_PIXEL_CAP: usize = 96;
const RENDER_AA_PIXEL_FRACTION: f64 = 0.01;
const RENDER_AA_FOUR_SAMPLE_CAP: usize = 24;
const RENDER_AA_FOUR_SAMPLE_FRACTION: f64 = 0.0025;
const RENDER_MIN_EDGE_CHROMA_SCALE: f64 = 0.35;
const RENDER_PALETTE_SIZE: usize = 2048;
const RENDER_INV_LN2: f64 = std::f64::consts::LOG2_E;
const RENDER_SMOOTH_LOG_SCALE: f64 = 0.5 * std::f64::consts::LOG2_E;
const RENDER_TWO_SAMPLE_OFFSETS: [(f64, f64); 2] = [(-0.25, -0.25), (0.25, 0.25)];
const RENDER_FOUR_SAMPLE_OFFSETS: [(f64, f64); 4] = [
    (-0.375, -0.125),
    (0.125, -0.375),
    (-0.125, 0.375),
    (0.375, 0.125),
];
const RENDER_REFERENCE_INTERIOR_MAX_PERIOD: usize = 256;
const RENDER_REFERENCE_INTERIOR_MAX_CANDIDATES: usize = 3;
const RENDER_REFERENCE_INTERIOR_MAX_PERIOD_SCORE: f64 = 3e-6;
const RENDER_REFERENCE_INTERIOR_MAX_C_VARIANCE: f64 = 1e-8;
const RENDER_REFERENCE_INTERIOR_DISTANCE_SCALE: f64 = 0.25;
const RENDER_REFERENCE_INTERIOR_RADIUS_SAFETY: f64 = 0.90;
const RENDER_REFERENCE_INTERIOR_MIN_BLOCK_SIZE: usize = 16;

#[wasm_bindgen]
pub fn reset_render_cache(_revision: u32) {
    RENDER_REFERENCE_CACHE.with(|cache| cache.borrow_mut().clear());
}

#[wasm_bindgen]
pub fn put_render_reference(
    numeric_id: u32,
    external_id: &str,
    screen_x: f64,
    screen_y: f64,
    escaped_at: u32,
    max_iter: u32,
    interior_radius: f64,
    orbit_re: Float64Array,
    orbit_im: Float64Array,
) {
    let orbit_re = orbit_re.to_vec();
    let orbit_im = orbit_im.to_vec();
    let interior_certificate = if escaped_at >= max_iter
        && interior_radius.is_finite()
        && interior_radius > 0.0
    {
        Some(ReferenceInteriorCertificate64 {
            radius: interior_radius,
        })
    } else {
        None
    };
    let reference = CachedRenderReference {
        external_id: external_id.to_string(),
        screen_x,
        screen_y,
        escaped_at,
        max_iter,
        orbit_re: Rc::new(orbit_re),
        orbit_im: Rc::new(orbit_im),
        interior_certificate,
    };
    RENDER_REFERENCE_CACHE.with(|cache| {
        cache.borrow_mut().insert(numeric_id, reference);
    });
}

#[wasm_bindgen]
pub fn render_tile_cached(
    tile_id: &str,
    revision: u32,
    rect_x: f64,
    rect_y: f64,
    rect_width: f64,
    rect_height: f64,
    pixel_span: f64,
    max_iter: u32,
    ref_ids: Int32Array,
    series_degree: u32,
    render_mode: &str,
    sample_step: f64,
    refinement_base_rgba: Uint8Array,
    refinement_mask: Uint8Array,
    refinement_smooth_values: Float32Array,
    refinement_escaped_mask: Uint8Array,
) -> Result<JsValue, JsValue> {
    let started = js_sys::Date::now();
    let rect = Rect64 {
        x: rect_x,
        y: rect_y,
        width: rect_width,
        height: rect_height,
    };
    let normalized_sample_step = if render_mode == "preview" {
        sample_step.floor().max(1.0)
    } else {
        1.0
    };
    let width = ((rect.width / normalized_sample_step).ceil().max(1.0)) as usize;
    let height = ((rect.height / normalized_sample_step).ceil().max(1.0)) as usize;
    let mut contexts = build_render_contexts(rect, pixel_span, &ref_ids)?;
    let palette = create_render_palette();
    let refinement_input = if render_mode == "final" {
        prepare_refinement_input(
            width,
            height,
            refinement_base_rgba,
            refinement_mask,
            refinement_smooth_values,
            refinement_escaped_mask,
        )
    } else {
        None
    };
    let using_refinement_mask = refinement_input.is_some();
    let (mut rgba, refinement_mask, refinement_smooth_values, refinement_escaped_mask) = if let Some(input) = refinement_input {
        (
            input.rgba,
            Some(input.mask),
            Some(input.smooth_values),
            Some(input.escaped_mask),
        )
    } else {
        (vec![0u8; width * height * 4], None, None, None)
    };
    let mut certified_interior_mask = if render_mode == "final" && !using_refinement_mask {
        Some(vec![0u8; width * height])
    } else {
        None
    };
    let mut scratch = PeriodicScratch64 {
        checkpoint_re: [0.0; 32],
        checkpoint_im: [0.0; 32],
        checkpoint_iter: [0; 32],
    };

    let mut glitch_count = 0u32;
    let mut unresolved_count = 0u32;
    let mut escaped_pixels = 0u32;
    let mut periodic_interior_count = 0u32;
    let mut iter_stats = empty_render_iter_stats(max_iter);
    let mut rebase_count = 0u32;
    let mut rebase_limit_count = 0u32;
    let mut bla_skip_count = 0u32;
    let mut bla_step_count = 0u32;
    let mut unresolved_screen_x_sum = 0.0;
    let mut unresolved_screen_y_sum = 0.0;
    let mut series_skip = 0usize;
    let mut used_reference_indices = vec![0u8; contexts.len()];
    let mut clusters = create_render_cluster_accumulators(rect);
    let mut unresolved_mask = vec![0u8; width * height];
    let mut escaped_mask = if render_mode == "final" {
        Some(refinement_escaped_mask.unwrap_or_else(|| vec![0u8; width * height]))
    } else {
        None
    };
    let mut cap_hit_unknown_mask = if render_mode == "final" {
        Some(vec![0u8; width * height])
    } else {
        None
    };
    let mut smooth_values = if render_mode == "final" {
        Some(refinement_smooth_values.unwrap_or_else(|| vec![0f32; width * height]))
    } else {
        None
    };
    if render_mode == "final" {
        if let Some(mask) = certified_interior_mask.as_mut() {
            periodic_interior_count += certify_render_blocks_from_references64(
                mask,
                &mut rgba,
                smooth_values.as_deref_mut(),
                &mut used_reference_indices,
                width,
                height,
                rect,
                normalized_sample_step,
                pixel_span,
                max_iter,
                &contexts,
                &palette,
            );
        }
    }
    let screen_xs: Vec<f64> = (0..width)
        .map(|px| {
            (rect.x + rect.width - 0.5).min(rect.x + (px as f64 + 0.5) * normalized_sample_step)
        })
        .collect();
    let screen_ys: Vec<f64> = (0..height)
        .map(|py| {
            (rect.y + rect.height - 0.5).min(rect.y + (py as f64 + 0.5) * normalized_sample_step)
        })
        .collect();

    for py in 0..height {
        let screen_y = screen_ys[py];
        for px in 0..width {
            let pixel_index = py * width + px;
            if refinement_mask
                .as_ref()
                .is_some_and(|mask| mask[pixel_index] == 0)
            {
                continue;
            }
            if certified_interior_mask
                .as_ref()
                .is_some_and(|mask| mask[pixel_index] != 0)
            {
                continue;
            }
            let screen_x = screen_xs[px];
            let selection = render_pixel_with_references64(
                screen_x,
                screen_y,
                pixel_span,
                max_iter,
                series_degree as usize,
                &mut contexts,
                &mut scratch,
            );
            let result = selection.result;
            let offset = pixel_index * 4;
            if result.iter < max_iter {
                escaped_pixels += 1;
                record_render_escaped_iter(&mut iter_stats, result.iter, max_iter);
            }
            if result.periodic_interior {
                periodic_interior_count += 1;
            }
            rebase_count += result.rebase_count;
            if result.rebase_limit {
                rebase_limit_count += 1;
            }
            bla_skip_count += result.bla_skip_count;
            bla_step_count += result.bla_step_count;
            if result.glitch {
                glitch_count += 1;
            }
            if selection.reference_index >= 0 {
                used_reference_indices[selection.reference_index as usize] = 1;
            }
            series_skip = series_skip.max(selection.skip);
            if result.unresolved {
                unresolved_count += 1;
                unresolved_screen_x_sum += screen_x;
                unresolved_screen_y_sum += screen_y;
                unresolved_mask[pixel_index] = 1;
                let source_reference_id = if selection.reference_index >= 0 {
                    contexts[selection.reference_index as usize]
                        .reference
                        .external_id
                        .as_str()
                } else {
                    ""
                };
                record_render_unresolved_cluster(
                    &mut clusters,
                    rect,
                    screen_x,
                    screen_y,
                    result.survived_iter,
                    result.failure_kind,
                    source_reference_id,
                );
            } else if result.iter < max_iter {
                if let Some(mask) = escaped_mask.as_mut() {
                    mask[pixel_index] = 1;
                }
            } else if !result.periodic_interior {
                iter_stats.cap_hit_unknown_count += 1;
                if let Some(mask) = cap_hit_unknown_mask.as_mut() {
                    mask[pixel_index] = 1;
                }
            }
            let smooth = render_smooth_iteration(result.iter, max_iter, result.mag2);
            if let Some(values) = smooth_values.as_mut() {
                values[pixel_index] = smooth as f32;
            }
            write_render_color_for_smooth(
                &mut rgba,
                offset,
                result.iter >= max_iter,
                smooth,
                &palette,
            );
        }
    }

    let boundary_stats = if render_mode == "final" && unresolved_count == 0 {
        apply_render_boundary_smoothing(
            &mut rgba,
            smooth_values.as_ref().unwrap(),
            escaped_mask.as_ref().unwrap(),
            &unresolved_mask,
            width,
            height,
            rect,
            pixel_span,
            max_iter,
            series_degree as usize,
            &mut contexts,
            &mut scratch,
            &palette,
        )
    } else {
        empty_render_boundary_stats()
    };
    if let (Some(cap_mask), Some(escaped_mask)) =
        (cap_hit_unknown_mask.as_ref(), escaped_mask.as_ref())
    {
        iter_stats.cap_hit_boundary_count =
            count_render_cap_hit_boundary(cap_mask, escaped_mask, &unresolved_mask, width, height);
    }
    let iter_summary = summarize_render_iter_stats(iter_stats);

    let unresolved_mask_output = if render_mode == "final" && unresolved_count > 0 {
        Some(unresolved_mask.clone())
    } else {
        None
    };
    let refinement_smooth_values_output = if render_mode == "final" && unresolved_count > 0 {
        smooth_values.clone()
    } else {
        None
    };
    let refinement_escaped_mask_output = if render_mode == "final" && unresolved_count > 0 {
        escaped_mask.clone()
    } else {
        None
    };

    if unresolved_count > 0 {
        fill_render_unresolved_preview(&mut rgba, &mut unresolved_mask, width, height);
    }

    let unresolved_clusters = build_render_unresolved_clusters(&clusters, rect);
    let reference_ids_used: Vec<String> = used_reference_indices
        .iter()
        .enumerate()
        .filter_map(|(index, used)| {
            if *used == 0 {
                None
            } else {
                Some(contexts[index].reference.external_id.clone())
            }
        })
        .collect();
    let elapsed_ms = js_sys::Date::now() - started;
    build_render_tile_value(
        tile_id,
        revision,
        rect,
        width,
        height,
        rgba,
        unresolved_mask_output,
        refinement_smooth_values_output,
        refinement_escaped_mask_output,
        unresolved_clusters,
        elapsed_ms,
        glitch_count,
        unresolved_count,
        escaped_pixels,
        periodic_interior_count,
        iter_summary,
        rebase_count,
        rebase_limit_count,
        bla_skip_count,
        bla_step_count,
        series_skip as u32,
        boundary_stats,
        reference_ids_used,
        if unresolved_count > 0 {
            Some(unresolved_screen_x_sum / unresolved_count as f64)
        } else {
            None
        },
        if unresolved_count > 0 {
            Some(unresolved_screen_y_sum / unresolved_count as f64)
        } else {
            None
        },
        render_mode,
        0,
    )
}

#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn render_tile_exact(
    tile_id: &str,
    revision: u32,
    rect_x: f64,
    rect_y: f64,
    rect_width: f64,
    rect_height: f64,
    center_re: &str,
    center_im: &str,
    center_screen_x: f64,
    center_screen_y: f64,
    scale: &str,
    canvas_width: f64,
    max_iter: u32,
    precision_bits: u32,
    base_rgba: Uint8Array,
    exact_mask: Uint8Array,
) -> Result<JsValue, JsValue> {
    let started = js_sys::Date::now();
    let rect = Rect64 {
        x: rect_x,
        y: rect_y,
        width: rect_width,
        height: rect_height,
    };
    let width = rect.width.ceil().max(1.0) as usize;
    let height = rect.height.ceil().max(1.0) as usize;
    let bits = precision_bits
        .max(estimate_precision_bits(scale, max_iter))
        .max(128);
    let p = precision(bits);
    let center_re = parse_float(center_re, bits)?;
    let center_im = parse_float(center_im, bits)?;
    let scale = parse_float(scale, bits)?;
    let pixel_span = bf_from_f64(BASE_VIEW_WIDTH, bits)
        .div(&scale, p, RM)
        .div(&bf_from_f64(canvas_width.max(1.0), bits), p, RM);
    let palette = create_render_palette();
    let exact_input = prepare_exact_input(width, height, base_rgba, exact_mask);
    let mut rgba = exact_input.rgba;
    let mask = exact_input.mask;
    let mut escaped_pixels = 0u32;
    let mut exact_pixels = 0u32;
    let mut iter_stats = empty_render_iter_stats(max_iter);
    let mut escaped_mask = vec![0u8; width * height];
    let mut cap_hit_unknown_mask = vec![0u8; width * height];
    let unresolved_mask = vec![0u8; width * height];

    for py in 0..height {
        let screen_y = (rect.y + rect.height - 0.5).min(rect.y + py as f64 + 0.5);
        let dy = bf_from_f64(screen_y - center_screen_y, bits);
        let ci = center_im.add(&pixel_span.mul(&dy, p, RM), p, RM);
        for px in 0..width {
            let pixel_index = py * width + px;
            if !should_render_exact_pixel(mask.as_deref(), pixel_index) {
                continue;
            }
            exact_pixels += 1;
            let screen_x = (rect.x + rect.width - 0.5).min(rect.x + px as f64 + 0.5);
            let dx = bf_from_f64(screen_x - center_screen_x, bits);
            let cr = center_re.add(&pixel_span.mul(&dx, p, RM), p, RM);
            let exact = run_exact_escape_with_mag2(&cr, &ci, max_iter, p);
            if exact.iter < max_iter {
                escaped_pixels += 1;
                record_render_escaped_iter(&mut iter_stats, exact.iter, max_iter);
                escaped_mask[pixel_index] = 1;
            } else {
                iter_stats.cap_hit_unknown_count += 1;
                cap_hit_unknown_mask[pixel_index] = 1;
            }
            let smooth = render_smooth_iteration(exact.iter, max_iter, exact.mag2);
            write_render_color_for_smooth(
                &mut rgba,
                pixel_index * 4,
                exact.iter >= max_iter,
                smooth,
                &palette,
            );
        }
    }
    iter_stats.cap_hit_boundary_count =
        count_render_cap_hit_boundary(&cap_hit_unknown_mask, &escaped_mask, &unresolved_mask, width, height);
    let iter_summary = summarize_render_iter_stats(iter_stats);

    build_render_tile_value(
        tile_id,
        revision,
        rect,
        width,
        height,
        rgba,
        None,
        None,
        None,
        Vec::new(),
        js_sys::Date::now() - started,
        0,
        0,
        escaped_pixels,
        0,
        iter_summary,
        0,
        0,
        0,
        0,
        0,
        empty_render_boundary_stats(),
        Vec::new(),
        None,
        None,
        "exact",
        exact_pixels,
    )
}

struct ExactInput {
    rgba: Vec<u8>,
    mask: Option<Vec<u8>>,
}

struct RefinementInput {
    rgba: Vec<u8>,
    mask: Vec<u8>,
    smooth_values: Vec<f32>,
    escaped_mask: Vec<u8>,
}

fn prepare_exact_input(width: usize, height: usize, base_rgba: Uint8Array, exact_mask: Uint8Array) -> ExactInput {
    let pixel_count = width * height;
    let rgba = if base_rgba.length() as usize == pixel_count * 4 {
        base_rgba.to_vec()
    } else {
        vec![0u8; pixel_count * 4]
    };
    let mask = if exact_mask.length() as usize == pixel_count {
        Some(exact_mask.to_vec())
    } else {
        None
    };
    ExactInput { rgba, mask }
}

fn prepare_refinement_input(
    width: usize,
    height: usize,
    base_rgba: Uint8Array,
    refinement_mask: Uint8Array,
    refinement_smooth_values: Float32Array,
    refinement_escaped_mask: Uint8Array,
) -> Option<RefinementInput> {
    let pixel_count = width * height;
    if base_rgba.length() as usize != pixel_count * 4
        || refinement_mask.length() as usize != pixel_count
        || refinement_smooth_values.length() as usize != pixel_count
        || refinement_escaped_mask.length() as usize != pixel_count
    {
        return None;
    }
    Some(RefinementInput {
        rgba: base_rgba.to_vec(),
        mask: refinement_mask.to_vec(),
        smooth_values: refinement_smooth_values.to_vec(),
        escaped_mask: refinement_escaped_mask.to_vec(),
    })
}

fn should_render_exact_pixel(mask: Option<&[u8]>, pixel_index: usize) -> bool {
    mask.map_or(true, |values| values.get(pixel_index).copied().unwrap_or(0) != 0)
}

struct ExactEscape64 {
    iter: u32,
    mag2: f64,
}

fn run_exact_escape_with_mag2(
    cr: &BigFloat,
    ci: &BigFloat,
    max_iter: u32,
    p: usize,
) -> ExactEscape64 {
    let mut zr = BigFloat::from_word(0, p);
    let mut zi = BigFloat::from_word(0, p);
    let four = BigFloat::from_word(4, p);

    for iter in 0..max_iter {
        if iter > 0 {
            let mag2 = zr.mul(&zr, p, RM).add(&zi.mul(&zi, p, RM), p, RM);
            if mag2.cmp(&four).is_some_and(|v| v > 0) {
                return ExactEscape64 {
                    iter,
                    mag2: bf_to_f64(&mag2),
                };
            }
        }
        let (next_re, next_im) = step_two_mul(&zr, &zi, cr, ci, p);
        zr = next_re;
        zi = next_im;
    }

    let mag2 = zr.mul(&zr, p, RM).add(&zi.mul(&zi, p, RM), p, RM);
    ExactEscape64 {
        iter: max_iter,
        mag2: bf_to_f64(&mag2),
    }
}

#[allow(clippy::too_many_arguments)]
fn certify_render_blocks_from_references64(
    mask: &mut [u8],
    rgba: &mut [u8],
    mut smooth_values: Option<&mut [f32]>,
    used_reference_indices: &mut [u8],
    width: usize,
    height: usize,
    rect: Rect64,
    sample_step: f64,
    pixel_span: f64,
    max_iter: u32,
    contexts: &[RenderContext],
    palette: &[u8],
) -> u32 {
    if width == 0 || height == 0 || contexts.is_empty() {
        return 0;
    }
    let mut certified = 0u32;
    certify_render_block_from_references64(
        mask,
        rgba,
        &mut smooth_values,
        used_reference_indices,
        width,
        rect,
        sample_step,
        pixel_span,
        max_iter,
        contexts,
        palette,
        0,
        0,
        width,
        height,
        &mut certified,
    );
    certified
}

#[allow(clippy::too_many_arguments)]
fn certify_render_block_from_references64(
    mask: &mut [u8],
    rgba: &mut [u8],
    smooth_values: &mut Option<&mut [f32]>,
    used_reference_indices: &mut [u8],
    stride: usize,
    rect: Rect64,
    sample_step: f64,
    pixel_span: f64,
    max_iter: u32,
    contexts: &[RenderContext],
    palette: &[u8],
    x0: usize,
    y0: usize,
    block_width: usize,
    block_height: usize,
    certified: &mut u32,
) {
    if block_width == 0 || block_height == 0 {
        return;
    }

    if let Some(reference_index) = certifying_reference_for_block64(
        contexts,
        rect,
        sample_step,
        pixel_span,
        x0,
        y0,
        block_width,
        block_height,
    ) {
        fill_certified_reference_block64(
            mask,
            rgba,
            smooth_values,
            stride,
            x0,
            y0,
            block_width,
            block_height,
            max_iter,
            palette,
        );
        if let Some(used) = used_reference_indices.get_mut(reference_index) {
            *used = 1;
        }
        *certified += (block_width * block_height) as u32;
        return;
    }

    if block_width <= RENDER_REFERENCE_INTERIOR_MIN_BLOCK_SIZE
        && block_height <= RENDER_REFERENCE_INTERIOR_MIN_BLOCK_SIZE
    {
        return;
    }

    if block_width >= block_height && block_width > RENDER_REFERENCE_INTERIOR_MIN_BLOCK_SIZE {
        let left_width = block_width / 2;
        let right_width = block_width - left_width;
        certify_render_block_from_references64(
            mask,
            rgba,
            smooth_values,
            used_reference_indices,
            stride,
            rect,
            sample_step,
            pixel_span,
            max_iter,
            contexts,
            palette,
            x0,
            y0,
            left_width,
            block_height,
            certified,
        );
        certify_render_block_from_references64(
            mask,
            rgba,
            smooth_values,
            used_reference_indices,
            stride,
            rect,
            sample_step,
            pixel_span,
            max_iter,
            contexts,
            palette,
            x0 + left_width,
            y0,
            right_width,
            block_height,
            certified,
        );
    } else if block_height > RENDER_REFERENCE_INTERIOR_MIN_BLOCK_SIZE {
        let top_height = block_height / 2;
        let bottom_height = block_height - top_height;
        certify_render_block_from_references64(
            mask,
            rgba,
            smooth_values,
            used_reference_indices,
            stride,
            rect,
            sample_step,
            pixel_span,
            max_iter,
            contexts,
            palette,
            x0,
            y0,
            block_width,
            top_height,
            certified,
        );
        certify_render_block_from_references64(
            mask,
            rgba,
            smooth_values,
            used_reference_indices,
            stride,
            rect,
            sample_step,
            pixel_span,
            max_iter,
            contexts,
            palette,
            x0,
            y0 + top_height,
            block_width,
            bottom_height,
            certified,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn certifying_reference_for_block64(
    contexts: &[RenderContext],
    rect: Rect64,
    sample_step: f64,
    pixel_span: f64,
    x0: usize,
    y0: usize,
    block_width: usize,
    block_height: usize,
) -> Option<usize> {
    let screen_x = rect.x + (x0 as f64 + block_width as f64 * 0.5) * sample_step;
    let screen_y = rect.y + (y0 as f64 + block_height as f64 * 0.5) * sample_step;
    let block_radius = (block_width as f64 * sample_step)
        .hypot(block_height as f64 * sample_step)
        * 0.5
        * pixel_span;
    if !screen_x.is_finite() || !screen_y.is_finite() || !block_radius.is_finite() {
        return None;
    }

    let mut best: Option<(usize, f64)> = None;
    for (index, context) in contexts.iter().enumerate() {
        let reference = &context.reference;
        if reference.escaped_at < reference.max_iter {
            continue;
        }
        let Some(certificate) = reference.interior_certificate else {
            continue;
        };
        let center_delta = (screen_x - reference.screen_x)
            .hypot(screen_y - reference.screen_y)
            * pixel_span;
        let covered_radius = certificate.radius * RENDER_REFERENCE_INTERIOR_RADIUS_SAFETY;
        if center_delta + block_radius <= covered_radius {
            let slack = covered_radius - center_delta - block_radius;
            if best.is_none_or(|(_, best_slack)| slack > best_slack) {
                best = Some((index, slack));
            }
        }
    }
    best.map(|(index, _)| index)
}

#[allow(clippy::too_many_arguments)]
fn fill_certified_reference_block64(
    mask: &mut [u8],
    rgba: &mut [u8],
    smooth_values: &mut Option<&mut [f32]>,
    stride: usize,
    x0: usize,
    y0: usize,
    block_width: usize,
    block_height: usize,
    max_iter: u32,
    palette: &[u8],
) {
    let smooth = max_iter as f64;
    for y in y0..(y0 + block_height) {
        for x in x0..(x0 + block_width) {
            let index = y * stride + x;
            mask[index] = 1;
            if let Some(values) = smooth_values.as_deref_mut() {
                values[index] = smooth as f32;
            }
            write_render_color_for_smooth(rgba, index * 4, true, smooth, palette);
        }
    }
}

fn reference_interior_certificate64(
    orbit_re: &[f64],
    orbit_im: &[f64],
    max_iter: u32,
) -> Option<ReferenceInteriorCertificate64> {
    let len = orbit_re.len().min(orbit_im.len());
    if len < 16 {
        return None;
    }
    let last_index = (max_iter as usize).min(len - 1);
    if last_index < 16 {
        return None;
    }

    let mut best_radius = 0.0;
    for period in candidate_reference_periods64(orbit_re, orbit_im, last_index) {
        if let Some(radius) = reference_interior_radius_for_period64(
            orbit_re,
            orbit_im,
            last_index,
            period,
        ) {
            if radius > best_radius {
                best_radius = radius;
            }
        }
    }
    if best_radius.is_finite() && best_radius > 0.0 {
        Some(ReferenceInteriorCertificate64 {
            radius: best_radius,
        })
    } else {
        None
    }
}

#[wasm_bindgen]
pub fn estimate_reference_interior_radius(
    escaped_at: u32,
    max_iter: u32,
    orbit_re: Float64Array,
    orbit_im: Float64Array,
) -> f64 {
    if escaped_at < max_iter {
        return 0.0;
    }
    reference_interior_certificate64(&orbit_re.to_vec(), &orbit_im.to_vec(), max_iter)
        .map(|certificate| certificate.radius)
        .filter(|radius| radius.is_finite() && *radius > 0.0)
        .unwrap_or(0.0)
}

fn candidate_reference_periods64(
    orbit_re: &[f64],
    orbit_im: &[f64],
    last_index: usize,
) -> Vec<usize> {
    let max_period = RENDER_REFERENCE_INTERIOR_MAX_PERIOD
        .min(last_index / 2)
        .max(1);
    let mut candidates: Vec<(usize, f64)> = Vec::with_capacity(max_period);
    for period in 1..=max_period {
        let d1 = complex_distance2_from_orbit64(orbit_re, orbit_im, last_index, last_index - period);
        let d2 = if last_index >= period * 2 {
            complex_distance2_from_orbit64(
                orbit_re,
                orbit_im,
                last_index - period,
                last_index - period * 2,
            )
        } else {
            d1
        };
        let score = d1.max(d2);
        if score.is_finite() && score <= RENDER_REFERENCE_INTERIOR_MAX_PERIOD_SCORE {
            candidates.push((period, score));
        }
    }
    candidates.sort_by(|a, b| a.1.total_cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    candidates.truncate(RENDER_REFERENCE_INTERIOR_MAX_CANDIDATES);
    candidates.into_iter().map(|(period, _)| period).collect()
}

fn reference_interior_radius_for_period64(
    orbit_re: &[f64],
    orbit_im: &[f64],
    last_index: usize,
    period: usize,
) -> Option<f64> {
    if period == 0 || last_index < period {
        return None;
    }
    let start = last_index - period;
    let (c, c_variance) = estimate_reference_parameter64(orbit_re, orbit_im, start, period)?;
    if !complex_is_finite(c)
        || !c_variance.is_finite()
        || c_variance > RENDER_REFERENCE_INTERIOR_MAX_C_VARIANCE
    {
        return None;
    }

    let mut z = orbit_point64(orbit_re, orbit_im, start)?;
    for _ in 0..16 {
        let derivatives = iterate_period_derivatives64(z, c, period)?;
        let residual = complex_sub(derivatives.z, z);
        let jacobian = complex_sub(derivatives.dz_dz, Complex64 { re: 1.0, im: 0.0 });
        if complex_abs(jacobian) <= 1e-14 {
            return None;
        }
        let delta = complex_div(residual, jacobian)?;
        if !complex_is_finite(delta) {
            return None;
        }
        z = complex_sub(z, delta);
        if complex_abs(delta) <= 1e-14 {
            break;
        }
    }

    let period = reduce_reference_period64(z, c, period);
    let derivatives = iterate_period_derivatives64(z, c, period)?;
    let residual = complex_abs(complex_sub(derivatives.z, z));
    let multiplier = complex_abs(derivatives.dz_dz);
    if residual > 1e-10 || !multiplier.is_finite() || multiplier >= 0.995 {
        return None;
    }

    let one_minus_multiplier = complex_sub(Complex64 { re: 1.0, im: 0.0 }, derivatives.dz_dz);
    let correction = complex_div(derivatives.dz_dc, one_minus_multiplier)?;
    let denominator = complex_add(
        derivatives.d_dc_dz,
        complex_mul(derivatives.d_dz_dz, correction),
    );
    let denominator_abs = complex_abs(denominator);
    if !denominator_abs.is_finite() || denominator_abs <= 1e-30 {
        return None;
    }

    let distance_estimate = (1.0 - multiplier * multiplier) / denominator_abs;
    let radius = distance_estimate * RENDER_REFERENCE_INTERIOR_DISTANCE_SCALE
        - residual * 32.0
        - c_variance * 8.0;
    if radius.is_finite() && radius > 0.0 {
        Some(radius)
    } else {
        None
    }
}

fn estimate_reference_parameter64(
    orbit_re: &[f64],
    orbit_im: &[f64],
    start: usize,
    period: usize,
) -> Option<(Complex64, f64)> {
    let mut values = Vec::with_capacity(period);
    let mut sum = Complex64 { re: 0.0, im: 0.0 };
    for offset in 0..period {
        let z = orbit_point64(orbit_re, orbit_im, start + offset)?;
        let next = orbit_point64(orbit_re, orbit_im, start + offset + 1)?;
        let c = complex_sub(next, complex_mul(z, z));
        if !complex_is_finite(c) {
            return None;
        }
        sum = complex_add(sum, c);
        values.push(c);
    }
    let c = complex_scale(sum, 1.0 / period as f64);
    let mut max_variance: f64 = 0.0;
    for value in values {
        max_variance = max_variance.max(complex_abs(complex_sub(value, c)));
    }
    Some((c, max_variance))
}

fn reduce_reference_period64(z: Complex64, c: Complex64, period: usize) -> usize {
    for candidate in 1..period {
        if period % candidate != 0 {
            continue;
        }
        let Some(derivatives) = iterate_period_derivatives64(z, c, candidate) else {
            continue;
        };
        if complex_abs(complex_sub(derivatives.z, z)) <= 1e-9 {
            return candidate;
        }
    }
    period
}

fn iterate_period_derivatives64(
    mut z: Complex64,
    c: Complex64,
    period: usize,
) -> Option<PeriodDerivatives64> {
    let mut dz_dz = Complex64 { re: 1.0, im: 0.0 };
    let mut dz_dc = Complex64 { re: 0.0, im: 0.0 };
    let mut d_dz_dz = Complex64 { re: 0.0, im: 0.0 };
    let mut d_dc_dz = Complex64 { re: 0.0, im: 0.0 };

    for _ in 0..period {
        if !complex_is_finite(z)
            || !complex_is_finite(dz_dz)
            || !complex_is_finite(dz_dc)
            || !complex_is_finite(d_dz_dz)
            || !complex_is_finite(d_dc_dz)
        {
            return None;
        }
        let two_z = complex_scale(z, 2.0);
        let next_d_dc_dz = complex_add(
            complex_scale(complex_mul(dz_dc, dz_dz), 2.0),
            complex_mul(two_z, d_dc_dz),
        );
        let next_d_dz_dz = complex_add(
            complex_scale(complex_mul(dz_dz, dz_dz), 2.0),
            complex_mul(two_z, d_dz_dz),
        );
        let next_dz_dc = complex_add(complex_mul(two_z, dz_dc), Complex64 { re: 1.0, im: 0.0 });
        let next_dz_dz = complex_mul(two_z, dz_dz);
        z = complex_add(complex_mul(z, z), c);
        dz_dz = next_dz_dz;
        dz_dc = next_dz_dc;
        d_dz_dz = next_d_dz_dz;
        d_dc_dz = next_d_dc_dz;
    }

    if !complex_is_finite(z)
        || !complex_is_finite(dz_dz)
        || !complex_is_finite(dz_dc)
        || !complex_is_finite(d_dz_dz)
        || !complex_is_finite(d_dc_dz)
    {
        return None;
    }

    Some(PeriodDerivatives64 {
        z,
        dz_dz,
        dz_dc,
        d_dz_dz,
        d_dc_dz,
    })
}

fn orbit_point64(orbit_re: &[f64], orbit_im: &[f64], index: usize) -> Option<Complex64> {
    let point = Complex64 {
        re: *orbit_re.get(index)?,
        im: *orbit_im.get(index)?,
    };
    if complex_is_finite(point) {
        Some(point)
    } else {
        None
    }
}

fn complex_distance2_from_orbit64(
    orbit_re: &[f64],
    orbit_im: &[f64],
    a: usize,
    b: usize,
) -> f64 {
    let re = orbit_re[a] - orbit_re[b];
    let im = orbit_im[a] - orbit_im[b];
    re * re + im * im
}

fn complex_add(a: Complex64, b: Complex64) -> Complex64 {
    Complex64 {
        re: a.re + b.re,
        im: a.im + b.im,
    }
}

fn complex_sub(a: Complex64, b: Complex64) -> Complex64 {
    Complex64 {
        re: a.re - b.re,
        im: a.im - b.im,
    }
}

fn complex_mul(a: Complex64, b: Complex64) -> Complex64 {
    Complex64 {
        re: a.re * b.re - a.im * b.im,
        im: a.re * b.im + a.im * b.re,
    }
}

fn complex_div(a: Complex64, b: Complex64) -> Option<Complex64> {
    let denom = b.re * b.re + b.im * b.im;
    if !denom.is_finite() || denom <= 0.0 {
        return None;
    }
    Some(Complex64 {
        re: (a.re * b.re + a.im * b.im) / denom,
        im: (a.im * b.re - a.re * b.im) / denom,
    })
}

fn complex_scale(a: Complex64, scale: f64) -> Complex64 {
    Complex64 {
        re: a.re * scale,
        im: a.im * scale,
    }
}

fn complex_abs2(a: Complex64) -> f64 {
    a.re * a.re + a.im * a.im
}

fn complex_abs(a: Complex64) -> f64 {
    complex_abs2(a).sqrt()
}

fn complex_is_finite(a: Complex64) -> bool {
    a.re.is_finite() && a.im.is_finite()
}

fn build_render_contexts(
    rect: Rect64,
    pixel_span: f64,
    ref_ids: &Int32Array,
) -> Result<Vec<RenderContext>, JsValue> {
    let mut contexts = Vec::with_capacity(ref_ids.length() as usize);
    for index in 0..ref_ids.length() {
        let id = ref_ids.get_index(index) as u32;
        let reference = RENDER_REFERENCE_CACHE
            .with(|cache| cache.borrow().get(&id).cloned())
            .ok_or_else(|| JsValue::from_str("render reference cache miss"))?;
        let radius = render_tile_radius(rect, reference.screen_x, reference.screen_y, pixel_span);
        let probes =
            render_tile_probe_offsets(rect, reference.screen_x, reference.screen_y, pixel_span);
        contexts.push(RenderContext {
            reference,
            radius,
            probes,
            series: None,
        });
    }
    Ok(contexts)
}

fn build_render_tile_value(
    tile_id: &str,
    revision: u32,
    rect: Rect64,
    width: usize,
    height: usize,
    rgba: Vec<u8>,
    unresolved_mask: Option<Vec<u8>>,
    refinement_smooth_values: Option<Vec<f32>>,
    refinement_escaped_mask: Option<Vec<u8>>,
    unresolved_clusters: Vec<UnresolvedCluster64>,
    elapsed_ms: f64,
    glitch_count: u32,
    unresolved_count: u32,
    escaped_pixels: u32,
    periodic_interior_count: u32,
    iter_summary: RenderIterSummary64,
    rebase_count: u32,
    rebase_limit_count: u32,
    bla_skip_count: u32,
    bla_step_count: u32,
    series_skip: u32,
    boundary_stats: BoundaryStats64,
    reference_ids_used: Vec<String>,
    unresolved_screen_x: Option<f64>,
    unresolved_screen_y: Option<f64>,
    render_mode: &str,
    exact_fallback_pixels: u32,
) -> Result<JsValue, JsValue> {
    let object = Object::new();
    set_js_property(&object, "type", &JsValue::from_str("tileDone"))?;
    set_js_property(&object, "tileId", &JsValue::from_str(tile_id))?;
    set_js_property(&object, "revision", &JsValue::from_f64(revision as f64))?;
    set_js_property(&object, "rect", &rect_to_js(rect)?.into())?;
    set_js_property(&object, "width", &JsValue::from_f64(width as f64))?;
    set_js_property(&object, "height", &JsValue::from_f64(height as f64))?;
    let rgba_array = Uint8ClampedArray::from(rgba.as_slice());
    set_js_property(&object, "rgba", &rgba_array.buffer().into())?;
    if let Some(mask) = unresolved_mask {
        let mask_array = Uint8Array::from(mask.as_slice());
        set_js_property(&object, "unresolvedMask", &mask_array.buffer().into())?;
    }
    if let Some(values) = refinement_smooth_values {
        let values_array = Float32Array::from(values.as_slice());
        set_js_property(&object, "refinementSmoothValues", &values_array.buffer().into())?;
    }
    if let Some(mask) = refinement_escaped_mask {
        let mask_array = Uint8Array::from(mask.as_slice());
        set_js_property(&object, "refinementEscapedMask", &mask_array.buffer().into())?;
    }
    set_js_property(
        &object,
        "needsReference",
        &JsValue::from_bool(!unresolved_clusters.is_empty()),
    )?;

    let stats = Object::new();
    set_js_property(&stats, "elapsedMs", &JsValue::from_f64(elapsed_ms))?;
    set_js_property(
        &stats,
        "glitchCount",
        &JsValue::from_f64(glitch_count as f64),
    )?;
    set_js_property(
        &stats,
        "unresolvedCount",
        &JsValue::from_f64(unresolved_count as f64),
    )?;
    set_js_property(
        &stats,
        "escapedPixels",
        &JsValue::from_f64(escaped_pixels as f64),
    )?;
    set_js_property(
        &stats,
        "periodicInteriorCount",
        &JsValue::from_f64(periodic_interior_count as f64),
    )?;
    set_js_property(
        &stats,
        "maxEscapedIter",
        &JsValue::from_f64(iter_summary.max_escaped_iter as f64),
    )?;
    set_js_property(
        &stats,
        "p95EscapedIter",
        &JsValue::from_f64(iter_summary.p95_escaped_iter as f64),
    )?;
    set_js_property(
        &stats,
        "nearCapEscapedCount",
        &JsValue::from_f64(iter_summary.near_cap_escaped_count as f64),
    )?;
    set_js_property(
        &stats,
        "capHitUnknownCount",
        &JsValue::from_f64(iter_summary.cap_hit_unknown_count as f64),
    )?;
    set_js_property(
        &stats,
        "capHitBoundaryCount",
        &JsValue::from_f64(iter_summary.cap_hit_boundary_count as f64),
    )?;
    set_js_property(
        &stats,
        "rebaseCount",
        &JsValue::from_f64(rebase_count as f64),
    )?;
    set_js_property(
        &stats,
        "rebaseLimitCount",
        &JsValue::from_f64(rebase_limit_count as f64),
    )?;
    set_js_property(
        &stats,
        "blaSkipCount",
        &JsValue::from_f64(bla_skip_count as f64),
    )?;
    set_js_property(
        &stats,
        "blaStepCount",
        &JsValue::from_f64(bla_step_count as f64),
    )?;
    set_js_property(&stats, "referenceCacheMissCount", &JsValue::from_f64(0.0))?;
    set_js_property(&stats, "seriesSkip", &JsValue::from_f64(series_skip as f64))?;
    set_js_property(
        &stats,
        "boundaryDampenedCount",
        &JsValue::from_f64(boundary_stats.boundary_dampened_count as f64),
    )?;
    set_js_property(
        &stats,
        "aaPixelCount",
        &JsValue::from_f64(boundary_stats.aa_pixel_count as f64),
    )?;
    set_js_property(
        &stats,
        "aaSampleCount",
        &JsValue::from_f64(boundary_stats.aa_sample_count as f64),
    )?;
    set_js_property(
        &stats,
        "aaFallbackCount",
        &JsValue::from_f64(boundary_stats.aa_fallback_count as f64),
    )?;
    let used_ids = Array::new();
    for id in &reference_ids_used {
        used_ids.push(&JsValue::from_str(id));
    }
    set_js_property(
        &stats,
        "referenceId",
        &JsValue::from_str(reference_ids_used.first().map(String::as_str).unwrap_or("")),
    )?;
    set_js_property(&stats, "referenceIdsUsed", used_ids.as_ref())?;
    set_js_property(
        &stats,
        "exactFallbackPixels",
        &JsValue::from_f64(exact_fallback_pixels as f64),
    )?;
    set_js_property(
        &stats,
        "unresolvedScreenX",
        &unresolved_screen_x.map_or(JsValue::UNDEFINED, JsValue::from_f64),
    )?;
    set_js_property(
        &stats,
        "unresolvedScreenY",
        &unresolved_screen_y.map_or(JsValue::UNDEFINED, JsValue::from_f64),
    )?;
    set_js_property(
        &stats,
        "unresolvedClusters",
        unresolved_clusters_to_js(&unresolved_clusters)?.as_ref(),
    )?;
    set_js_property(
        &stats,
        "preview",
        &JsValue::from_bool(render_mode == "preview"),
    )?;
    set_js_property(&stats, "renderMode", &JsValue::from_str(render_mode))?;
    set_js_property(&object, "stats", stats.as_ref())?;
    Ok(object.into())
}

fn rect_to_js(rect: Rect64) -> Result<Object, JsValue> {
    let object = Object::new();
    set_js_property(&object, "x", &JsValue::from_f64(rect.x))?;
    set_js_property(&object, "y", &JsValue::from_f64(rect.y))?;
    set_js_property(&object, "width", &JsValue::from_f64(rect.width))?;
    set_js_property(&object, "height", &JsValue::from_f64(rect.height))?;
    Ok(object)
}

fn unresolved_clusters_to_js(clusters: &[UnresolvedCluster64]) -> Result<Array, JsValue> {
    let array = Array::new();
    for cluster in clusters {
        let object = Object::new();
        set_js_property(&object, "screenX", &JsValue::from_f64(cluster.screen_x))?;
        set_js_property(&object, "screenY", &JsValue::from_f64(cluster.screen_y))?;
        set_js_property(
            &object,
            "pixelCount",
            &JsValue::from_f64(cluster.pixel_count as f64),
        )?;
        set_js_property(
            &object,
            "survivedIter",
            &JsValue::from_f64(cluster.survived_iter as f64),
        )?;
        set_js_property(&object, "radiusPx", &JsValue::from_f64(cluster.radius_px))?;
        set_js_property(&object, "binX", &JsValue::from_f64(cluster.bin_x as f64))?;
        set_js_property(&object, "binY", &JsValue::from_f64(cluster.bin_y as f64))?;
        set_js_property(&object, "bounds", &rect_to_js(cluster.bounds)?.into())?;
        set_js_property(
            &object,
            "bestSurvivedIter",
            &JsValue::from_f64(cluster.survived_iter as f64),
        )?;
        set_js_property(
            &object,
            "sourceReferenceId",
            &JsValue::from_str(&cluster.source_reference_id),
        )?;
        set_js_property(
            &object,
            "failureKindCounts",
            &failure_kind_counts_to_js(cluster.failure_kind_counts)?.into(),
        )?;
        set_js_property(
            &object,
            "suggestedPrecisionBits",
            &JsValue::from_f64(cluster.suggested_precision_bits as f64),
        )?;
        array.push(object.as_ref());
    }
    Ok(array)
}

fn failure_kind_counts_to_js(counts: [u32; 5]) -> Result<Object, JsValue> {
    let object = Object::new();
    for (index, count) in counts.iter().enumerate() {
        set_js_property(
            &object,
            failure_kind_key(index),
            &JsValue::from_f64(*count as f64),
        )?;
    }
    Ok(object)
}

fn render_pixel_with_references64(
    screen_x: f64,
    screen_y: f64,
    pixel_span: f64,
    max_iter: u32,
    series_degree: usize,
    contexts: &mut [RenderContext],
    scratch: &mut PeriodicScratch64,
) -> PixelSelection64 {
    let mut has_best_unresolved = false;
    let mut best_unresolved = failure_result64(
        max_iter,
        0.0,
        true,
        FailureKind64::EarlyReferenceEscape,
        0,
        0,
        false,
        0,
        0,
    );
    let mut best_unresolved_reference_index = -1;
    let mut max_skip = 0usize;
    let allow_periodic_interior = pixel_span >= RENDER_MIN_PIXEL_SPAN_FOR_PERIODIC_INTERIOR;

    for index in 0..contexts.len() {
        let c_re = (screen_x - contexts[index].reference.screen_x) * pixel_span;
        let c_im = (screen_y - contexts[index].reference.screen_y) * pixel_span;
        ensure_render_series(&mut contexts[index], series_degree);
        let series = contexts[index].series.as_ref().unwrap();
        let result = perturb64(
            c_re,
            c_im,
            &contexts[index].reference.orbit_re,
            &contexts[index].reference.orbit_im,
            max_iter,
            series,
            allow_periodic_interior,
            scratch,
        );
        max_skip = max_skip.max(series.skip);
        if !result.unresolved {
            return PixelSelection64 {
                result,
                reference_index: index as i32,
                skip: max_skip,
            };
        }
        if !has_best_unresolved || result.survived_iter > best_unresolved.survived_iter {
            best_unresolved = result;
            has_best_unresolved = true;
            best_unresolved_reference_index = index as i32;
        }
    }

    PixelSelection64 {
        result: best_unresolved,
        reference_index: best_unresolved_reference_index,
        skip: max_skip,
    }
}

fn ensure_render_series(context: &mut RenderContext, series_degree: usize) {
    if context.series.is_none() {
        context.series = Some(build_series_plan64(
            &context.reference.orbit_re,
            &context.reference.orbit_im,
            series_degree,
            RENDER_SERIES_MAX_SKIP,
            context.radius,
            &context.probes,
        ));
    }
}

fn perturb64(
    c_re: f64,
    c_im: f64,
    orbit_re: &[f64],
    orbit_im: &[f64],
    max_iter: u32,
    series: &SeriesPlan64,
    allow_periodic_interior: bool,
    scratch: &mut PeriodicScratch64,
) -> PixelResult64 {
    let mut dz_re = 0.0;
    let mut dz_im = 0.0;
    let mut iter = 0u32;
    let mut ref_index = 0usize;
    let mut mag2 = 0.0;
    let mut glitch = false;
    let mut failure_kind = FailureKind64::EarlyReferenceEscape;
    let mut rebase_count = 0u32;
    let mut rebase_limit = false;
    let bla_skip_count = 0u32;
    let bla_step_count = 0u32;
    let mut checkpoint_count = 0usize;
    let mut checkpoint_index = 0usize;

    if series.skip > 0 {
        let dz = evaluate_series64(series, c_re, c_im);
        dz_re = dz.re;
        dz_im = dz.im;
        iter = series.skip as u32;
        ref_index = series.skip;
    }

    let limit = max_iter.min((orbit_re.len().saturating_sub(1)) as u32) as usize;
    if ref_index > limit {
        return failure_result64(
            max_iter,
            mag2,
            true,
            if series.skip > 0 {
                FailureKind64::SeriesUnsafe
            } else {
                FailureKind64::EarlyReferenceEscape
            },
            limit as u32,
            rebase_count,
            rebase_limit,
            bla_skip_count,
            bla_step_count,
        );
    }

    while iter <= max_iter && ref_index <= limit {
        let ref_re = orbit_re[ref_index];
        let ref_im = orbit_im[ref_index];
        if !ref_re.is_finite() || !ref_im.is_finite() {
            glitch = true;
            failure_kind = FailureKind64::DeltaOverflow;
            break;
        }

        let z_re = ref_re + dz_re;
        let z_im = ref_im + dz_im;
        mag2 = z_re * z_re + z_im * z_im;
        if mag2 > 4.0 {
            return success_result64(
                iter,
                mag2,
                glitch,
                false,
                rebase_count,
                rebase_limit,
                bla_skip_count,
                bla_step_count,
            );
        }
        if iter >= max_iter {
            return success_result64(
                max_iter,
                mag2,
                false,
                false,
                rebase_count,
                rebase_limit,
                bla_skip_count,
                bla_step_count,
            );
        }

        if allow_periodic_interior && iter > 32 && iter % 8 == 0 {
            let cycle_tolerance = 1e-20 * 1.0f64.max(mag2);
            for checkpoint in 0..checkpoint_count {
                if iter - scratch.checkpoint_iter[checkpoint] < 32 {
                    continue;
                }
                let cycle_delta_re = z_re - scratch.checkpoint_re[checkpoint];
                let cycle_delta_im = z_im - scratch.checkpoint_im[checkpoint];
                let cycle_delta2 =
                    cycle_delta_re * cycle_delta_re + cycle_delta_im * cycle_delta_im;
                if cycle_delta2.is_finite() && cycle_delta2 < cycle_tolerance {
                    return success_result64(
                        max_iter,
                        mag2,
                        false,
                        true,
                        rebase_count,
                        rebase_limit,
                        bla_skip_count,
                        bla_step_count,
                    );
                }
            }
            scratch.checkpoint_re[checkpoint_index] = z_re;
            scratch.checkpoint_im[checkpoint_index] = z_im;
            scratch.checkpoint_iter[checkpoint_index] = iter;
            checkpoint_index = (checkpoint_index + 1) % scratch.checkpoint_re.len();
            checkpoint_count = (checkpoint_count + 1).min(scratch.checkpoint_re.len());
        }

        let ref_mag2 = ref_re * ref_re + ref_im * ref_im;
        let dz_mag2_before_step = dz_re * dz_re + dz_im * dz_im;
        let mut step_ref_re = ref_re;
        let mut step_ref_im = ref_im;
        let mut step_ref_mag2 = ref_mag2;
        if ref_index > 0
            && mag2.is_finite()
            && ref_mag2.is_finite()
            && ref_mag2 > 1e-30
            && mag2 < ref_mag2 * RENDER_REBASE_G
        {
            if rebase_count >= RENDER_MAX_REBASES_PER_PIXEL {
                glitch = true;
                rebase_limit = true;
                failure_kind = FailureKind64::RebaseLimit;
                break;
            }
            dz_re = z_re;
            dz_im = z_im;
            ref_index = 0;
            step_ref_re = orbit_re[0];
            step_ref_im = orbit_im[0];
            step_ref_mag2 = step_ref_re * step_ref_re + step_ref_im * step_ref_im;
            rebase_count += 1;
        } else if !mag2.is_finite()
            || !ref_mag2.is_finite()
            || !dz_mag2_before_step.is_finite()
            || (ref_mag2 > 1e-30
                && dz_mag2_before_step > 1e-30
                && dz_mag2_before_step > ref_mag2 * 1e-4
                && mag2 < ref_mag2 * 1e-20)
        {
            glitch = true;
            failure_kind = if !mag2.is_finite()
                || !ref_mag2.is_finite()
                || !dz_mag2_before_step.is_finite()
            {
                FailureKind64::DeltaOverflow
            } else {
                FailureKind64::CancellationGlitch
            };
            break;
        }

        if ref_index == limit {
            break;
        }

        let dz2_re = dz_re * dz_re - dz_im * dz_im;
        let dz2_im = 2.0 * dz_re * dz_im;
        let two_ref_dz_re = 2.0 * (step_ref_re * dz_re - step_ref_im * dz_im);
        let two_ref_dz_im = 2.0 * (step_ref_re * dz_im + step_ref_im * dz_re);
        dz_re = two_ref_dz_re + dz2_re + c_re;
        dz_im = two_ref_dz_im + dz2_im + c_im;
        iter += 1;
        ref_index += 1;

        let dz_mag2 = dz_re * dz_re + dz_im * dz_im;
        if !dz_mag2.is_finite() || (step_ref_mag2 > 1e-24 && dz_mag2 > step_ref_mag2 * 1e8) {
            glitch = true;
            failure_kind = FailureKind64::DeltaOverflow;
            break;
        }
    }

    if glitch || iter < max_iter {
        return failure_result64(
            max_iter,
            mag2,
            true,
            if glitch {
                failure_kind
            } else {
                FailureKind64::EarlyReferenceEscape
            },
            iter.min(max_iter),
            rebase_count,
            rebase_limit,
            bla_skip_count,
            bla_step_count,
        );
    }
    success_result64(
        max_iter,
        mag2,
        false,
        false,
        rebase_count,
        rebase_limit,
        bla_skip_count,
        bla_step_count,
    )
}

fn success_result64(
    iter: u32,
    mag2: f64,
    glitch: bool,
    periodic_interior: bool,
    rebase_count: u32,
    rebase_limit: bool,
    bla_skip_count: u32,
    bla_step_count: u32,
) -> PixelResult64 {
    PixelResult64 {
        iter,
        mag2,
        glitch,
        unresolved: false,
        failure_kind: FailureKind64::None,
        survived_iter: iter,
        periodic_interior,
        rebase_count,
        rebase_limit,
        bla_skip_count,
        bla_step_count,
    }
}

fn failure_result64(
    iter: u32,
    mag2: f64,
    glitch: bool,
    failure_kind: FailureKind64,
    survived_iter: u32,
    rebase_count: u32,
    rebase_limit: bool,
    bla_skip_count: u32,
    bla_step_count: u32,
) -> PixelResult64 {
    PixelResult64 {
        iter,
        mag2,
        glitch,
        unresolved: true,
        failure_kind,
        survived_iter,
        periodic_interior: false,
        rebase_count,
        rebase_limit,
        bla_skip_count,
        bla_step_count,
    }
}

fn build_series_plan64(
    orbit_re: &[f64],
    orbit_im: &[f64],
    degree: usize,
    max_skip: usize,
    tile_radius: f64,
    probes: &[Complex64],
) -> SeriesPlan64 {
    let normalized_degree = degree;
    if normalized_degree > 2 {
        let mut best = build_series_plan_for_degree64(
            orbit_re,
            orbit_im,
            2,
            max_skip,
            tile_radius,
            probes,
        );
        if is_series_skip_saturated64(best.skip, max_skip, orbit_re, orbit_im) {
            return best;
        }
        for candidate_degree in [4usize, 8, 12] {
            if candidate_degree > normalized_degree {
                break;
            }
            let candidate = build_series_plan_for_degree64(
                orbit_re,
                orbit_im,
                candidate_degree,
                max_skip,
                tile_radius,
                probes,
            );
            if candidate.skip > best.skip
                || (candidate.skip == best.skip && candidate.degree < best.degree)
            {
                best = candidate;
            }
            if is_series_skip_saturated64(best.skip, max_skip, orbit_re, orbit_im) {
                break;
            }
        }
        return best;
    }
    build_series_plan_for_degree64(
        orbit_re,
        orbit_im,
        normalized_degree,
        max_skip,
        tile_radius,
        probes,
    )
}

fn is_series_skip_saturated64(
    skip: usize,
    max_skip: usize,
    orbit_re: &[f64],
    orbit_im: &[f64],
) -> bool {
    let available_skip = max_skip
        .min(orbit_re.len().saturating_sub(1))
        .min(orbit_im.len().saturating_sub(1));
    available_skip > 0
        && skip >= ((available_skip as f64) * RENDER_SERIES_SKIP_SATURATION).ceil() as usize
}

fn build_series_plan_for_degree64(
    orbit_re: &[f64],
    orbit_im: &[f64],
    normalized_degree: usize,
    max_skip: usize,
    tile_radius: f64,
    probes: &[Complex64],
) -> SeriesPlan64 {
    let mut coeff_re = vec![0.0; normalized_degree + 1];
    let mut coeff_im = vec![0.0; normalized_degree + 1];
    if normalized_degree < 2
        || max_skip == 0
        || !tile_radius.is_finite()
        || tile_radius <= 0.0
        || tile_radius > RENDER_MAX_SERIES_TILE_RADIUS
        || orbit_re.len() < 2
        || orbit_im.len() < 2
        || probes.is_empty()
    {
        return SeriesPlan64 {
            skip: 0,
            degree: normalized_degree,
            coeff_re,
            coeff_im,
        };
    }

    let mut next_re = vec![0.0; normalized_degree + 1];
    let mut next_im = vec![0.0; normalized_degree + 1];
    let mut probe_re = vec![0.0; probes.len()];
    let mut probe_im = vec![0.0; probes.len()];
    let mut next_probe_re = vec![0.0; probes.len()];
    let mut next_probe_im = vec![0.0; probes.len()];
    let mut skip = 0usize;

    for n in 0..max_skip.min(orbit_re.len() - 1) {
        next_re.fill(0.0);
        next_im.fill(0.0);
        let zr = orbit_re[n];
        let zi = orbit_im[n];
        if !zr.is_finite() || !zi.is_finite() {
            break;
        }

        for k in 1..=normalized_degree {
            let ar = coeff_re[k];
            let ai = coeff_im[k];
            next_re[k] += 2.0 * (zr * ar - zi * ai);
            next_im[k] += 2.0 * (zr * ai + zi * ar);
            if k == 1 {
                next_re[k] += 1.0;
            }
            for j in 1..k {
                let br = coeff_re[j];
                let bi = coeff_im[j];
                let cr = coeff_re[k - j];
                let ci = coeff_im[k - j];
                next_re[k] += br * cr - bi * ci;
                next_im[k] += br * ci + bi * cr;
            }
        }

        if !probes_validate_series_step64(
            probes,
            &probe_re,
            &probe_im,
            &mut next_probe_re,
            &mut next_probe_im,
            &next_re,
            &next_im,
            orbit_re,
            orbit_im,
            n,
            tile_radius,
        ) {
            break;
        }

        coeff_re.copy_from_slice(&next_re);
        coeff_im.copy_from_slice(&next_im);
        probe_re.copy_from_slice(&next_probe_re);
        probe_im.copy_from_slice(&next_probe_im);
        skip = n + 1;
    }

    SeriesPlan64 {
        skip,
        degree: normalized_degree,
        coeff_re,
        coeff_im,
    }
}

fn evaluate_series64(plan: &SeriesPlan64, c_re: f64, c_im: f64) -> Complex64 {
    let mut zr = 0.0;
    let mut zi = 0.0;
    for k in (1..=plan.degree).rev() {
        let pr = zr * c_re - zi * c_im + plan.coeff_re[k];
        let pi = zr * c_im + zi * c_re + plan.coeff_im[k];
        zr = pr;
        zi = pi;
    }
    Complex64 {
        re: zr * c_re - zi * c_im,
        im: zr * c_im + zi * c_re,
    }
}

#[allow(clippy::too_many_arguments)]
fn probes_validate_series_step64(
    probes: &[Complex64],
    probe_re: &[f64],
    probe_im: &[f64],
    next_probe_re: &mut [f64],
    next_probe_im: &mut [f64],
    coeff_re: &[f64],
    coeff_im: &[f64],
    orbit_re: &[f64],
    orbit_im: &[f64],
    n: usize,
    tile_radius: f64,
) -> bool {
    let zr = orbit_re[n];
    let zi = orbit_im[n];
    let next_ref_re = orbit_re[n + 1];
    let next_ref_im = orbit_im[n + 1];
    if !next_ref_re.is_finite() || !next_ref_im.is_finite() {
        return false;
    }

    for index in 0..probes.len() {
        let c_re = probes[index].re;
        let c_im = probes[index].im;
        let dz_re = probe_re[index];
        let dz_im = probe_im[index];
        let dz2_re = dz_re * dz_re - dz_im * dz_im;
        let dz2_im = 2.0 * dz_re * dz_im;
        let two_ref_dz_re = 2.0 * (zr * dz_re - zi * dz_im);
        let two_ref_dz_im = 2.0 * (zr * dz_im + zi * dz_re);
        let exact_re = two_ref_dz_re + dz2_re + c_re;
        let exact_im = two_ref_dz_im + dz2_im + c_im;
        if !exact_re.is_finite() || !exact_im.is_finite() {
            return false;
        }

        let z_re = next_ref_re + exact_re;
        let z_im = next_ref_im + exact_im;
        let mag2 = z_re * z_re + z_im * z_im;
        if !mag2.is_finite() || mag2 > 4.0 {
            return false;
        }

        let ref_mag2 = next_ref_re * next_ref_re + next_ref_im * next_ref_im;
        let dz_mag2 = exact_re * exact_re + exact_im * exact_im;
        if is_render_cancellation_glitch(mag2, ref_mag2, dz_mag2) {
            return false;
        }

        let mut estimate_zr = 0.0;
        let mut estimate_zi = 0.0;
        for k in (1..coeff_re.len()).rev() {
            let pr = estimate_zr * c_re - estimate_zi * c_im + coeff_re[k];
            let pi = estimate_zr * c_im + estimate_zi * c_re + coeff_im[k];
            estimate_zr = pr;
            estimate_zi = pi;
        }
        let estimate_re = estimate_zr * c_re - estimate_zi * c_im;
        let estimate_im = estimate_zr * c_im + estimate_zi * c_re;
        if !estimate_re.is_finite() || !estimate_im.is_finite() {
            return false;
        }
        let error = (exact_re - estimate_re).hypot(exact_im - estimate_im);
        let exact_mag = exact_re.hypot(exact_im);
        let estimate_mag = estimate_re.hypot(estimate_im);
        let allowed = RENDER_SERIES_ERROR_SCALE
            * tile_radius
                .max(exact_mag)
                .max(estimate_mag)
                .max(f64::MIN_POSITIVE);
        if !error.is_finite() || error > allowed {
            return false;
        }

        next_probe_re[index] = exact_re;
        next_probe_im[index] = exact_im;
    }
    true
}

fn is_render_cancellation_glitch(mag2: f64, ref_mag2: f64, dz_mag2: f64) -> bool {
    if !mag2.is_finite() || !ref_mag2.is_finite() || !dz_mag2.is_finite() {
        return true;
    }
    if ref_mag2 <= 1e-30 || dz_mag2 <= 1e-30 {
        return false;
    }
    dz_mag2 > ref_mag2 * 1e-4 && mag2 < ref_mag2 * 1e-20
}

fn create_render_cluster_accumulators(rect: Rect64) -> Vec<ClusterAccumulator64> {
    let cols = if rect.width >= rect.height * 1.5 {
        8
    } else {
        4
    };
    let rows = 4;
    let mut clusters = Vec::with_capacity((cols * rows) as usize);
    for bin_y in 0..rows {
        for bin_x in 0..cols {
            clusters.push(ClusterAccumulator64 {
                bin_x,
                bin_y,
                bounds: Rect64 {
                    x: rect.x + rect.width * bin_x as f64 / cols as f64,
                    y: rect.y + rect.height * bin_y as f64 / rows as f64,
                    width: rect.width / cols as f64,
                    height: rect.height / rows as f64,
                },
                count: 0,
                sum_x: 0.0,
                sum_y: 0.0,
                min_x: f64::INFINITY,
                min_y: f64::INFINITY,
                max_x: f64::NEG_INFINITY,
                max_y: f64::NEG_INFINITY,
                best_x: 0.0,
                best_y: 0.0,
                best_survived_iter: -1,
                best_source_reference_id: None,
                failure_kind_counts: [0; 5],
            });
        }
    }
    clusters
}

fn record_render_unresolved_cluster(
    clusters: &mut [ClusterAccumulator64],
    rect: Rect64,
    screen_x: f64,
    screen_y: f64,
    survived_iter: u32,
    failure_kind: FailureKind64,
    source_reference_id: &str,
) {
    let cols = if rect.width >= rect.height * 1.5 {
        8
    } else {
        4
    };
    let rows = 4;
    let bin_x = (((screen_x - rect.x) / rect.width.max(1.0)) * cols as f64)
        .floor()
        .max(0.0)
        .min((cols - 1) as f64) as usize;
    let bin_y = (((screen_y - rect.y) / rect.height.max(1.0)) * rows as f64)
        .floor()
        .max(0.0)
        .min((rows - 1) as f64) as usize;
    let index = bin_y * cols as usize + bin_x;
    let cluster = &mut clusters[index];
    cluster.count += 1;
    cluster.sum_x += screen_x;
    cluster.sum_y += screen_y;
    cluster.min_x = cluster.min_x.min(screen_x);
    cluster.min_y = cluster.min_y.min(screen_y);
    cluster.max_x = cluster.max_x.max(screen_x);
    cluster.max_y = cluster.max_y.max(screen_y);
    if let Some(failure_index) = failure_kind_index(failure_kind) {
        cluster.failure_kind_counts[failure_index] += 1;
    }
    if survived_iter as i32 > cluster.best_survived_iter {
        cluster.best_survived_iter = survived_iter as i32;
        cluster.best_x = screen_x;
        cluster.best_y = screen_y;
        cluster.best_source_reference_id = if source_reference_id.is_empty() {
            None
        } else {
            Some(source_reference_id.to_string())
        };
    }
}

fn build_render_unresolved_clusters(
    clusters: &[ClusterAccumulator64],
    rect: Rect64,
) -> Vec<UnresolvedCluster64> {
    let radius_px = 0.5f64.max(rect.width.hypot(rect.height) * 0.25);
    let mut result: Vec<UnresolvedCluster64> = clusters
        .iter()
        .filter(|cluster| cluster.count > 0)
        .map(|cluster| {
            let bounds = if cluster.min_x.is_finite()
                && cluster.min_y.is_finite()
                && cluster.max_x.is_finite()
                && cluster.max_y.is_finite()
            {
                let left = cluster.min_x.floor();
                let top = cluster.min_y.floor();
                let right = cluster.max_x.ceil().max(left + 1.0);
                let bottom = cluster.max_y.ceil().max(top + 1.0);
                Rect64 {
                    x: left,
                    y: top,
                    width: right - left,
                    height: bottom - top,
                }
            } else {
                cluster.bounds
            };
            UnresolvedCluster64 {
                screen_x: if cluster.best_x != 0.0 {
                    cluster.best_x
                } else {
                    cluster.sum_x / cluster.count as f64
                },
                screen_y: if cluster.best_y != 0.0 {
                    cluster.best_y
                } else {
                    cluster.sum_y / cluster.count as f64
                },
                pixel_count: cluster.count,
                survived_iter: cluster.best_survived_iter.max(0) as u32,
                radius_px,
                bin_x: cluster.bin_x,
                bin_y: cluster.bin_y,
                bounds,
                source_reference_id: cluster.best_source_reference_id.clone().unwrap_or_default(),
                failure_kind_counts: cluster.failure_kind_counts,
                suggested_precision_bits: suggested_precision_bits_for_cluster(
                    cluster.best_survived_iter.max(0) as u32,
                ),
            }
        })
        .collect();
    result.sort_by(|a, b| {
        b.pixel_count
            .cmp(&a.pixel_count)
            .then_with(|| b.survived_iter.cmp(&a.survived_iter))
    });
    result.truncate(16);
    result
}

fn failure_kind_index(kind: FailureKind64) -> Option<usize> {
    match kind {
        FailureKind64::None => None,
        FailureKind64::EarlyReferenceEscape => Some(0),
        FailureKind64::CancellationGlitch => Some(1),
        FailureKind64::DeltaOverflow => Some(2),
        FailureKind64::RebaseLimit => Some(3),
        FailureKind64::SeriesUnsafe => Some(4),
    }
}

fn failure_kind_key(index: usize) -> &'static str {
    match index {
        0 => "earlyReferenceEscape",
        1 => "cancellationGlitch",
        2 => "deltaOverflow",
        3 => "rebaseLimit",
        _ => "seriesUnsafe",
    }
}

fn suggested_precision_bits_for_cluster(survived_iter: u32) -> u32 {
    let orbit_margin = ((survived_iter.max(1) as f64).log2() * 4.0).ceil() as u32;
    (128 + orbit_margin).clamp(128, 4096)
}

#[allow(clippy::too_many_arguments)]
fn apply_render_boundary_smoothing(
    buffer: &mut [u8],
    smooth_values: &[f32],
    escaped_mask: &[u8],
    unresolved_mask: &[u8],
    width: usize,
    height: usize,
    rect: Rect64,
    pixel_span: f64,
    max_iter: u32,
    series_degree: usize,
    contexts: &mut [RenderContext],
    scratch: &mut PeriodicScratch64,
    palette: &[u8],
) -> BoundaryStats64 {
    if width <= 1 || height <= 1 {
        return empty_render_boundary_stats();
    }
    let mut edge_strengths = vec![0f32; width * height];
    let mut classification_changes = vec![0u8; width * height];
    let mut candidates: Vec<BoundaryCandidate64> = Vec::new();
    let mut boundary_dampened_count = 0u32;

    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            if unresolved_mask[index] != 0 {
                continue;
            }
            let edge = render_edge_strength_at(
                index,
                x,
                y,
                width,
                height,
                smooth_values,
                escaped_mask,
                unresolved_mask,
            );
            edge_strengths[index] = edge.edge_strength as f32;
            if edge.classification_change {
                classification_changes[index] = 1;
            }
            if edge.edge_strength >= RENDER_AA_EDGE_THRESHOLD {
                candidates.push(BoundaryCandidate64 {
                    index,
                    edge_strength: edge.edge_strength,
                    classification_change: edge.classification_change,
                });
            }
        }
    }

    candidates.sort_by(|a, b| {
        b.classification_change
            .cmp(&a.classification_change)
            .then_with(|| b.edge_strength.total_cmp(&a.edge_strength))
            .then_with(|| a.index.cmp(&b.index))
    });
    let aa_limit = candidates
        .len()
        .min(RENDER_AA_PIXEL_CAP)
        .min(((width * height) as f64 * RENDER_AA_PIXEL_FRACTION).ceil() as usize);
    let four_sample_limit = aa_limit
        .min(RENDER_AA_FOUR_SAMPLE_CAP)
        .min(((width * height) as f64 * RENDER_AA_FOUR_SAMPLE_FRACTION).ceil() as usize);
    let mut aa_pixel_count = 0u32;
    let mut aa_sample_count = 0u32;
    let mut aa_fallback_count = 0u32;
    let mut supersampled_mask = vec![0u8; width * height];

    if !contexts.is_empty() {
        let pixel_step_x = rect.width / width as f64;
        let pixel_step_y = rect.height / height as f64;
        for candidate_index in 0..aa_limit {
            let candidate = candidates[candidate_index];
            let x = candidate.index % width;
            let y = candidate.index / width;
            let screen_x = (rect.x + rect.width - 0.5 * pixel_step_x)
                .min(rect.x + (x as f64 + 0.5) * pixel_step_x);
            let screen_y = (rect.y + rect.height - 0.5 * pixel_step_y)
                .min(rect.y + (y as f64 + 0.5) * pixel_step_y);
            let offsets: &[(f64, f64)] = if candidate_index < four_sample_limit {
                &RENDER_FOUR_SAMPLE_OFFSETS
            } else {
                &RENDER_TWO_SAMPLE_OFFSETS
            };
            let fallbacks = render_supersample_pixel(
                buffer,
                candidate.index,
                screen_x,
                screen_y,
                pixel_step_x,
                pixel_step_y,
                offsets,
                pixel_span,
                max_iter,
                series_degree,
                contexts,
                scratch,
                palette,
            );
            aa_pixel_count += 1;
            aa_sample_count += offsets.len() as u32;
            aa_fallback_count += fallbacks;
            supersampled_mask[candidate.index] = 1;
        }
    }

    for index in 0..edge_strengths.len() {
        let edge_strength = edge_strengths[index] as f64;
        if edge_strength <= 0.0 || unresolved_mask[index] != 0 || supersampled_mask[index] != 0 {
            continue;
        }
        if escaped_mask[index] == 0 {
            if classification_changes[index] == 0 {
                continue;
            }
            if blend_render_interior_boundary_from_neighbors(
                buffer,
                index,
                width,
                height,
                escaped_mask,
                unresolved_mask,
            ) {
                boundary_dampened_count += 1;
            }
            continue;
        }
        let offset = index * 4;
        let color = Color64 {
            r: buffer[offset],
            g: buffer[offset + 1],
            b: buffer[offset + 2],
        };
        write_render_color(buffer, offset, dampen_render_chroma(color, edge_strength));
        boundary_dampened_count += 1;
    }

    BoundaryStats64 {
        boundary_dampened_count,
        aa_pixel_count,
        aa_sample_count,
        aa_fallback_count,
    }
}

fn empty_render_boundary_stats() -> BoundaryStats64 {
    BoundaryStats64 {
        boundary_dampened_count: 0,
        aa_pixel_count: 0,
        aa_sample_count: 0,
        aa_fallback_count: 0,
    }
}

fn empty_render_iter_stats(_max_iter: u32) -> RenderIterStats64 {
    RenderIterStats64 {
        escaped_iters: Vec::new(),
        max_escaped_iter: 0,
        near_cap_escaped_count: 0,
        cap_hit_unknown_count: 0,
        cap_hit_boundary_count: 0,
    }
}

fn record_render_escaped_iter(stats: &mut RenderIterStats64, iter: u32, max_iter: u32) {
    stats.max_escaped_iter = stats.max_escaped_iter.max(iter);
    if (iter as f64) >= (max_iter as f64 * 0.85) {
        stats.near_cap_escaped_count += 1;
    }
    stats.escaped_iters.push(iter);
}

fn summarize_render_iter_stats(mut stats: RenderIterStats64) -> RenderIterSummary64 {
    stats.escaped_iters.sort_unstable();
    let p95_escaped_iter = if stats.escaped_iters.is_empty() {
        0
    } else {
        let index = ((stats.escaped_iters.len() as f64 - 1.0) * 0.95).round() as usize;
        stats.escaped_iters[index.min(stats.escaped_iters.len() - 1)]
    };
    RenderIterSummary64 {
        max_escaped_iter: stats.max_escaped_iter,
        p95_escaped_iter,
        near_cap_escaped_count: stats.near_cap_escaped_count,
        cap_hit_unknown_count: stats.cap_hit_unknown_count,
        cap_hit_boundary_count: stats.cap_hit_boundary_count,
    }
}

fn count_render_cap_hit_boundary(
    cap_hit_unknown_mask: &[u8],
    escaped_mask: &[u8],
    unresolved_mask: &[u8],
    width: usize,
    height: usize,
) -> u32 {
    let mut count = 0u32;
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            if cap_hit_unknown_mask[index] == 0 || unresolved_mask[index] != 0 {
                continue;
            }
            let mut touches_escaped = false;
            for (dx, dy) in [(1isize, 0isize), (-1, 0), (0, 1), (0, -1)] {
                let nx = x as isize + dx;
                let ny = y as isize + dy;
                if nx < 0 || ny < 0 || nx >= width as isize || ny >= height as isize {
                    continue;
                }
                let neighbor_index = ny as usize * width + nx as usize;
                if escaped_mask[neighbor_index] != 0 {
                    touches_escaped = true;
                    break;
                }
            }
            if touches_escaped {
                count += 1;
            }
        }
    }
    count
}

fn render_edge_strength_at(
    index: usize,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
    smooth_values: &[f32],
    escaped_mask: &[u8],
    unresolved_mask: &[u8],
) -> RenderEdgeInfo64 {
    let escaped = escaped_mask[index] != 0;
    let smooth = smooth_values[index] as f64;
    let mut max_smooth_delta = 0.0;
    let mut classification_change = false;
    for (dx, dy) in [(1isize, 0isize), (-1, 0), (0, 1), (0, -1)] {
        let nx = x as isize + dx;
        let ny = y as isize + dy;
        if nx < 0 || ny < 0 || nx >= width as isize || ny >= height as isize {
            continue;
        }
        let neighbor_index = ny as usize * width + nx as usize;
        if unresolved_mask[neighbor_index] != 0 {
            continue;
        }
        let neighbor_escaped = escaped_mask[neighbor_index] != 0;
        if neighbor_escaped != escaped {
            classification_change = true;
        }
        if neighbor_escaped && escaped {
            max_smooth_delta = f64::max(
                max_smooth_delta,
                (smooth - smooth_values[neighbor_index] as f64).abs(),
            );
        } else if neighbor_escaped || escaped {
            max_smooth_delta = f64::max(max_smooth_delta, RENDER_SMOOTH_DELTA_HIGH);
        }
    }
    let smooth_edge = clamp01(
        (max_smooth_delta - RENDER_SMOOTH_DELTA_LOW)
            / (RENDER_SMOOTH_DELTA_HIGH - RENDER_SMOOTH_DELTA_LOW),
    );
    RenderEdgeInfo64 {
        edge_strength: clamp01(
            smooth_edge
                + if classification_change {
                    RENDER_CLASSIFICATION_EDGE_BOOST
                } else {
                    0.0
                },
        ),
        classification_change,
    }
}

#[allow(clippy::too_many_arguments)]
fn render_supersample_pixel(
    buffer: &mut [u8],
    pixel_index: usize,
    screen_x: f64,
    screen_y: f64,
    pixel_step_x: f64,
    pixel_step_y: f64,
    offsets: &[(f64, f64)],
    pixel_span: f64,
    max_iter: u32,
    series_degree: usize,
    contexts: &mut [RenderContext],
    scratch: &mut PeriodicScratch64,
    palette: &[u8],
) -> u32 {
    let base_offset = pixel_index * 4;
    let mut linear_r = srgb_to_linear(buffer[base_offset] as f64 / 255.0);
    let mut linear_g = srgb_to_linear(buffer[base_offset + 1] as f64 / 255.0);
    let mut linear_b = srgb_to_linear(buffer[base_offset + 2] as f64 / 255.0);
    let mut fallbacks = 0u32;

    for (offset_x, offset_y) in offsets {
        let selection = render_pixel_with_references64(
            screen_x + offset_x * pixel_step_x,
            screen_y + offset_y * pixel_step_y,
            pixel_span,
            max_iter,
            series_degree,
            contexts,
            scratch,
        );
        let color = if selection.result.unresolved {
            fallbacks += 1;
            Color64 {
                r: buffer[base_offset],
                g: buffer[base_offset + 1],
                b: buffer[base_offset + 2],
            }
        } else {
            color_for_render_result(
                selection.result.iter,
                max_iter,
                selection.result.mag2,
                palette,
            )
        };
        linear_r += srgb_to_linear(color.r as f64 / 255.0);
        linear_g += srgb_to_linear(color.g as f64 / 255.0);
        linear_b += srgb_to_linear(color.b as f64 / 255.0);
    }

    let divisor = offsets.len() as f64 + 1.0;
    write_render_color(
        buffer,
        base_offset,
        Color64 {
            r: clamp_byte((linear_to_srgb(linear_r / divisor) * 255.0).round()),
            g: clamp_byte((linear_to_srgb(linear_g / divisor) * 255.0).round()),
            b: clamp_byte((linear_to_srgb(linear_b / divisor) * 255.0).round()),
        },
    );
    fallbacks
}

fn blend_render_interior_boundary_from_neighbors(
    buffer: &mut [u8],
    pixel_index: usize,
    width: usize,
    height: usize,
    escaped_mask: &[u8],
    unresolved_mask: &[u8],
) -> bool {
    let x = pixel_index % width;
    let y = pixel_index / width;
    let base_offset = pixel_index * 4;
    let mut linear_r = srgb_to_linear(buffer[base_offset] as f64 / 255.0);
    let mut linear_g = srgb_to_linear(buffer[base_offset + 1] as f64 / 255.0);
    let mut linear_b = srgb_to_linear(buffer[base_offset + 2] as f64 / 255.0);
    let mut total_weight = 1.0;
    let mut escaped_neighbors = 0u32;

    for dy in -1isize..=1 {
        for dx in -1isize..=1 {
            if dx == 0 && dy == 0 {
                continue;
            }
            let nx = x as isize + dx;
            let ny = y as isize + dy;
            if nx < 0 || ny < 0 || nx >= width as isize || ny >= height as isize {
                continue;
            }
            let neighbor_index = ny as usize * width + nx as usize;
            if unresolved_mask[neighbor_index] != 0 || escaped_mask[neighbor_index] == 0 {
                continue;
            }
            let neighbor_offset = neighbor_index * 4;
            let weight = if dx == 0 || dy == 0 { 1.0 } else { 0.5 };
            linear_r += srgb_to_linear(buffer[neighbor_offset] as f64 / 255.0) * weight;
            linear_g += srgb_to_linear(buffer[neighbor_offset + 1] as f64 / 255.0) * weight;
            linear_b += srgb_to_linear(buffer[neighbor_offset + 2] as f64 / 255.0) * weight;
            total_weight += weight;
            escaped_neighbors += 1;
        }
    }

    if escaped_neighbors == 0 {
        return false;
    }

    write_render_color(
        buffer,
        base_offset,
        Color64 {
            r: clamp_byte((linear_to_srgb(linear_r / total_weight) * 255.0).round()),
            g: clamp_byte((linear_to_srgb(linear_g / total_weight) * 255.0).round()),
            b: clamp_byte((linear_to_srgb(linear_b / total_weight) * 255.0).round()),
        },
    );
    true
}

fn fill_render_unresolved_preview(
    buffer: &mut [u8],
    unresolved_mask: &mut [u8],
    width: usize,
    height: usize,
) {
    for pass in 0..3 {
        let mut changed = false;
        for y in 0..height {
            for x in 0..width {
                let pixel_index = y * width + x;
                if unresolved_mask[pixel_index] == 0 {
                    continue;
                }
                let mut red = 0u32;
                let mut green = 0u32;
                let mut blue = 0u32;
                let mut count = 0u32;
                for dy in -1isize..=1 {
                    for dx in -1isize..=1 {
                        if dx == 0 && dy == 0 {
                            continue;
                        }
                        let nx = x as isize + dx;
                        let ny = y as isize + dy;
                        if nx < 0 || ny < 0 || nx >= width as isize || ny >= height as isize {
                            continue;
                        }
                        let neighbor_index = ny as usize * width + nx as usize;
                        if unresolved_mask[neighbor_index] != 0 {
                            continue;
                        }
                        let offset = neighbor_index * 4;
                        red += buffer[offset] as u32;
                        green += buffer[offset + 1] as u32;
                        blue += buffer[offset + 2] as u32;
                        count += 1;
                    }
                }
                let offset = pixel_index * 4;
                if count > 0 {
                    buffer[offset] = ((red as f64 / count as f64).round()) as u8;
                    buffer[offset + 1] = ((green as f64 / count as f64).round()) as u8;
                    buffer[offset + 2] = ((blue as f64 / count as f64).round()) as u8;
                    buffer[offset + 3] = 255;
                    unresolved_mask[pixel_index] = 0;
                    changed = true;
                } else if pass == 2 {
                    buffer[offset] = 40;
                    buffer[offset + 1] = 162;
                    buffer[offset + 2] = 142;
                    buffer[offset + 3] = 255;
                }
            }
        }
        if !changed && pass == 2 {
            break;
        }
    }
}

fn render_tile_radius(rect: Rect64, screen_x: f64, screen_y: f64, pixel_span: f64) -> f64 {
    let corners = [
        (rect.x, rect.y),
        (rect.x + rect.width, rect.y),
        (rect.x, rect.y + rect.height),
        (rect.x + rect.width, rect.y + rect.height),
    ];
    corners
        .iter()
        .map(|(x, y)| (x - screen_x).hypot(y - screen_y) * pixel_span)
        .fold(0.0, f64::max)
}

fn render_tile_probe_offsets(
    rect: Rect64,
    screen_x: f64,
    screen_y: f64,
    pixel_span: f64,
) -> Vec<Complex64> {
    let min_x = rect.x + 0.5;
    let max_x = rect.x + 0.5f64.max(rect.width - 0.5);
    let min_y = rect.y + 0.5;
    let max_y = rect.y + 0.5f64.max(rect.height - 0.5);
    let mid_x = rect.x + rect.width * 0.5;
    let mid_y = rect.y + rect.height * 0.5;
    [
        (mid_x, mid_y),
        (min_x, min_y),
        (max_x, min_y),
        (min_x, max_y),
        (max_x, max_y),
        (mid_x, min_y),
        (mid_x, max_y),
        (min_x, mid_y),
        (max_x, mid_y),
    ]
    .into_iter()
    .map(|(x, y)| Complex64 {
        re: (x - screen_x) * pixel_span,
        im: (y - screen_y) * pixel_span,
    })
    .collect()
}

fn color_for_render_result(iter: u32, max_iter: u32, mag2: f64, palette: &[u8]) -> Color64 {
    if iter >= max_iter {
        return Color64 { r: 4, g: 8, b: 16 };
    }
    let smooth = render_smooth_iteration(iter, max_iter, mag2);
    let offset = render_palette_index(smooth) * 3;
    Color64 {
        r: palette[offset],
        g: palette[offset + 1],
        b: palette[offset + 2],
    }
}

fn write_render_color_for_smooth(
    buffer: &mut [u8],
    offset: usize,
    interior: bool,
    smooth: f64,
    palette: &[u8],
) {
    if interior {
        buffer[offset] = 4;
        buffer[offset + 1] = 8;
        buffer[offset + 2] = 16;
        buffer[offset + 3] = 255;
        return;
    }
    let palette_offset = render_palette_index(smooth) * 3;
    buffer[offset] = palette[palette_offset];
    buffer[offset + 1] = palette[palette_offset + 1];
    buffer[offset + 2] = palette[palette_offset + 2];
    buffer[offset + 3] = 255;
}

fn create_render_palette() -> Vec<u8> {
    let mut palette = vec![0u8; RENDER_PALETTE_SIZE * 3];
    for index in 0..RENDER_PALETTE_SIZE {
        let t = index as f64 / RENDER_PALETTE_SIZE as f64;
        let wave = |phase: f64| 0.5 + 0.5 * (std::f64::consts::TAU * (t + phase)).cos();
        let offset = index * 3;
        palette[offset] = clamp_byte((255.0 * wave(0.95).powf(1.4)).round());
        palette[offset + 1] = clamp_byte((255.0 * wave(0.58).powf(1.1)).round());
        palette[offset + 2] = clamp_byte((255.0 * wave(0.22).powf(0.9)).round());
    }
    palette
}

fn render_palette_index(smooth: f64) -> usize {
    let value = smooth * 0.018;
    let fraction = value - value.floor();
    ((fraction * RENDER_PALETTE_SIZE as f64).floor().max(0.0) as usize).min(RENDER_PALETTE_SIZE - 1)
}

fn render_smooth_iteration(iter: u32, max_iter: u32, mag2: f64) -> f64 {
    if iter >= max_iter {
        return max_iter as f64;
    }
    iter as f64 + 1.0
        - (mag2.max(4.0).ln() * RENDER_SMOOTH_LOG_SCALE)
            .max(1e-12)
            .ln()
            * RENDER_INV_LN2
}

fn dampen_render_chroma(color: Color64, edge_strength: f64) -> Color64 {
    let chroma_scale = 1.0 - (1.0 - RENDER_MIN_EDGE_CHROMA_SCALE) * clamp01(edge_strength);
    let linear_r = srgb_to_linear(color.r as f64 / 255.0);
    let linear_g = srgb_to_linear(color.g as f64 / 255.0);
    let linear_b = srgb_to_linear(color.b as f64 / 255.0);
    let luma = 0.2126 * linear_r + 0.7152 * linear_g + 0.0722 * linear_b;
    Color64 {
        r: clamp_byte((linear_to_srgb(luma + (linear_r - luma) * chroma_scale) * 255.0).round()),
        g: clamp_byte((linear_to_srgb(luma + (linear_g - luma) * chroma_scale) * 255.0).round()),
        b: clamp_byte((linear_to_srgb(luma + (linear_b - luma) * chroma_scale) * 255.0).round()),
    }
}

fn write_render_color(buffer: &mut [u8], offset: usize, color: Color64) {
    buffer[offset] = color.r;
    buffer[offset + 1] = color.g;
    buffer[offset + 2] = color.b;
    buffer[offset + 3] = 255;
}

fn srgb_to_linear(value: f64) -> f64 {
    if value <= 0.04045 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_srgb(value: f64) -> f64 {
    let clamped = clamp01(value);
    if clamped <= 0.0031308 {
        clamped * 12.92
    } else {
        1.055 * clamped.powf(1.0 / 2.4) - 0.055
    }
}

fn clamp01(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    value.max(0.0).min(1.0)
}

fn clamp_byte(value: f64) -> u8 {
    if !value.is_finite() {
        return 0;
    }
    value.max(0.0).min(255.0).round() as u8
}

fn compute_reference_with_mode(
    center_re: &str,
    center_im: &str,
    max_iter: u32,
    precision_bits: u32,
    mode: ReferenceMode,
) -> Result<JsValue, JsValue> {
    let bits = precision_bits.max(estimate_precision_bits("1", max_iter));
    let p = precision(bits);
    let cr = parse_float(center_re, bits)?;
    let ci = parse_float(center_im, bits)?;
    let orbit = run_reference_orbit(&cr, &ci, max_iter, p, mode, true);
    build_reference_value(center_re, center_im, bits, orbit)
}

#[wasm_bindgen]
pub fn estimate_precision_bits(scale: &str, max_iter: u32) -> u32 {
    let zoom = scale.parse::<f64>().unwrap_or(1.0).abs().max(1.0);
    let decimal_digits = zoom.log10().max(0.0);
    let orbit_margin = ((max_iter.max(1) as f64).log2() * 4.0).ceil();
    (128.0 + decimal_digits * std::f64::consts::LOG2_10 + orbit_margin)
        .ceil()
        .clamp(128.0, 4096.0) as u32
}

#[wasm_bindgen]
pub fn apply_view_transform(
    view: JsValue,
    pan_x: f64,
    pan_y: f64,
    zoom_factor: f64,
    anchor_x: f64,
    anchor_y: f64,
) -> Result<JsValue, JsValue> {
    let view: ViewInput = serde_wasm_bindgen::from_value(view)?;
    let next_scale_f64 = view.scale.parse::<f64>().unwrap_or(1.0) * zoom_factor.max(1e-300);
    let bits = estimate_precision_bits(&next_scale_f64.to_string(), 2048)
        .max(estimate_precision_bits(&view.scale, 2048));

    let re = parse_float(&view.re, bits)?;
    let im = parse_float(&view.im, bits)?;
    let scale = parse_float(&view.scale, bits)?;
    let zoom = bf_from_f64(zoom_factor.max(1e-300), bits);
    let next_scale = scale.mul(&zoom, precision(bits), RM);

    let base_span = bf_from_f64(BASE_VIEW_WIDTH, bits);
    let old_pixel_span = base_span.div(&scale, precision(bits), RM).div(
        &bf_from_f64(view.width.max(1.0), bits),
        precision(bits),
        RM,
    );
    let new_pixel_span = base_span.div(&next_scale, precision(bits), RM).div(
        &bf_from_f64(view.width.max(1.0), bits),
        precision(bits),
        RM,
    );

    let ax = anchor_x - view.width * 0.5;
    let ay = anchor_y - view.height * 0.5;
    let old_anchor_re = re.add(
        &old_pixel_span.mul(&bf_from_f64(ax, bits), precision(bits), RM),
        precision(bits),
        RM,
    );
    let old_anchor_im = im.add(
        &old_pixel_span.mul(&bf_from_f64(ay, bits), precision(bits), RM),
        precision(bits),
        RM,
    );

    let after_zoom_re = old_anchor_re.sub(
        &new_pixel_span.mul(&bf_from_f64(ax, bits), precision(bits), RM),
        precision(bits),
        RM,
    );
    let after_zoom_im = old_anchor_im.sub(
        &new_pixel_span.mul(&bf_from_f64(ay, bits), precision(bits), RM),
        precision(bits),
        RM,
    );

    let next_re = after_zoom_re.sub(
        &new_pixel_span.mul(&bf_from_f64(pan_x, bits), precision(bits), RM),
        precision(bits),
        RM,
    );
    let next_im = after_zoom_im.sub(
        &new_pixel_span.mul(&bf_from_f64(pan_y, bits), precision(bits), RM),
        precision(bits),
        RM,
    );
    let digits = decimal_digits(bits);

    serde_wasm_bindgen::to_value(&ViewOutput {
        re: bf_to_string(&next_re, digits),
        im: bf_to_string(&next_im, digits),
        scale: bf_to_string(&next_scale, digits),
    })
    .map_err(|err| JsValue::from_str(&err.to_string()))
}

#[wasm_bindgen]
pub fn compute_reference(
    center_re: &str,
    center_im: &str,
    max_iter: u32,
    precision_bits: u32,
) -> Result<JsValue, JsValue> {
    compute_reference_with_mode(
        center_re,
        center_im,
        max_iter,
        precision_bits,
        ReferenceMode::TwoMulSparse {
            check_interval: DEFAULT_REFERENCE_CHECK_INTERVAL,
        },
    )
}

#[wasm_bindgen]
pub fn compute_reference_3mul(
    center_re: &str,
    center_im: &str,
    max_iter: u32,
    precision_bits: u32,
) -> Result<JsValue, JsValue> {
    compute_reference_with_mode(
        center_re,
        center_im,
        max_iter,
        precision_bits,
        ReferenceMode::ThreeMul,
    )
}

#[wasm_bindgen]
pub fn compute_reference_sparse(
    center_re: &str,
    center_im: &str,
    max_iter: u32,
    precision_bits: u32,
    check_interval: u32,
) -> Result<JsValue, JsValue> {
    compute_reference_with_mode(
        center_re,
        center_im,
        max_iter,
        precision_bits,
        ReferenceMode::TwoMulSparse {
            check_interval: check_interval.max(1),
        },
    )
}

#[wasm_bindgen]
pub fn compute_reference_no_escape_check(
    center_re: &str,
    center_im: &str,
    max_iter: u32,
    precision_bits: u32,
) -> Result<JsValue, JsValue> {
    compute_reference_with_mode(
        center_re,
        center_im,
        max_iter,
        precision_bits,
        ReferenceMode::TwoMulNoEscapeCheck,
    )
}

#[wasm_bindgen]
pub fn direct_escape(
    re: &str,
    im: &str,
    max_iter: u32,
    precision_bits: u32,
) -> Result<u32, JsValue> {
    let bits = precision_bits.max(128);
    let p = precision(bits);
    let cr = parse_float(re, bits)?;
    let ci = parse_float(im, bits)?;
    Ok(run_reference_orbit(
        &cr,
        &ci,
        max_iter,
        p,
        ReferenceMode::TwoMulSparse {
            check_interval: DEFAULT_REFERENCE_CHECK_INTERVAL,
        },
        false,
    )
    .escaped_at)
}
