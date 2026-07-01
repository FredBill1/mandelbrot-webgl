use astro_float::{BigFloat, RoundingMode, Sign};
use js_sys::{Array, Float64Array, Int32Array, Object, Reflect, Uint8ClampedArray};
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
    orbit_re: Rc<Vec<f64>>,
    orbit_im: Rc<Vec<f64>>,
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
    survived_iter: u32,
    periodic_interior: bool,
    rebase_count: u32,
    rebase_limit: bool,
    bla_skip_count: u32,
    bla_step_count: u32,
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

#[derive(Clone)]
struct ClusterAccumulator64 {
    bin_x: u32,
    bin_y: u32,
    bounds: Rect64,
    count: u32,
    sum_x: f64,
    sum_y: f64,
    best_x: f64,
    best_y: f64,
    best_survived_iter: i32,
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

#[derive(Clone, Copy)]
struct BoundaryCandidate64 {
    index: usize,
    edge_strength: f64,
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
const RENDER_SMOOTH_DELTA_LOW: f64 = 6.0;
const RENDER_SMOOTH_DELTA_HIGH: f64 = 24.0;
const RENDER_CLASSIFICATION_EDGE_BOOST: f64 = 0.35;
const RENDER_AA_EDGE_THRESHOLD: f64 = 0.45;
const RENDER_AA_PIXEL_CAP: usize = 128;
const RENDER_AA_PIXEL_FRACTION: f64 = 0.01;
const RENDER_AA_FOUR_SAMPLE_CAP: usize = 32;
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
    _escaped_at: u32,
    _max_iter: u32,
    orbit_re: Float64Array,
    orbit_im: Float64Array,
) {
    let reference = CachedRenderReference {
        external_id: external_id.to_string(),
        screen_x,
        screen_y,
        orbit_re: Rc::new(orbit_re.to_vec()),
        orbit_im: Rc::new(orbit_im.to_vec()),
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
    let mut rgba = vec![0u8; width * height * 4];
    let mut scratch = PeriodicScratch64 {
        checkpoint_re: [0.0; 32],
        checkpoint_im: [0.0; 32],
        checkpoint_iter: [0; 32],
    };

    let mut glitch_count = 0u32;
    let mut unresolved_count = 0u32;
    let mut escaped_pixels = 0u32;
    let mut periodic_interior_count = 0u32;
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
        Some(vec![0u8; width * height])
    } else {
        None
    };
    let mut smooth_values = if render_mode == "final" {
        Some(vec![0f32; width * height])
    } else {
        None
    };
    let screen_xs: Vec<f64> = (0..width)
        .map(|px| (rect.x + rect.width - 0.5).min(rect.x + (px as f64 + 0.5) * normalized_sample_step))
        .collect();
    let screen_ys: Vec<f64> = (0..height)
        .map(|py| (rect.y + rect.height - 0.5).min(rect.y + (py as f64 + 0.5) * normalized_sample_step))
        .collect();

    for py in 0..height {
        let screen_y = screen_ys[py];
        for px in 0..width {
            let pixel_index = py * width + px;
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
                record_render_unresolved_cluster(&mut clusters, rect, screen_x, screen_y, result.survived_iter);
            } else if result.iter < max_iter {
                if let Some(mask) = escaped_mask.as_mut() {
                    mask[pixel_index] = 1;
                }
            }
            let smooth = render_smooth_iteration(result.iter, max_iter, result.mag2);
            if let Some(values) = smooth_values.as_mut() {
                values[pixel_index] = smooth as f32;
            }
            write_render_color_for_smooth(&mut rgba, offset, result.iter >= max_iter, smooth, &palette);
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
        unresolved_clusters,
        elapsed_ms,
        glitch_count,
        unresolved_count,
        escaped_pixels,
        periodic_interior_count,
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
    )
}

fn build_render_contexts(rect: Rect64, pixel_span: f64, ref_ids: &Int32Array) -> Result<Vec<RenderContext>, JsValue> {
    let mut contexts = Vec::with_capacity(ref_ids.length() as usize);
    for index in 0..ref_ids.length() {
        let id = ref_ids.get_index(index) as u32;
        let reference = RENDER_REFERENCE_CACHE
            .with(|cache| cache.borrow().get(&id).cloned())
            .ok_or_else(|| JsValue::from_str("render reference cache miss"))?;
        let radius = render_tile_radius(rect, reference.screen_x, reference.screen_y, pixel_span);
        let probes = render_tile_probe_offsets(rect, reference.screen_x, reference.screen_y, pixel_span);
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
    unresolved_clusters: Vec<UnresolvedCluster64>,
    elapsed_ms: f64,
    glitch_count: u32,
    unresolved_count: u32,
    escaped_pixels: u32,
    periodic_interior_count: u32,
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
    set_js_property(
        &object,
        "needsReference",
        &JsValue::from_bool(!unresolved_clusters.is_empty()),
    )?;

    let stats = Object::new();
    set_js_property(&stats, "elapsedMs", &JsValue::from_f64(elapsed_ms))?;
    set_js_property(&stats, "glitchCount", &JsValue::from_f64(glitch_count as f64))?;
    set_js_property(&stats, "unresolvedCount", &JsValue::from_f64(unresolved_count as f64))?;
    set_js_property(&stats, "escapedPixels", &JsValue::from_f64(escaped_pixels as f64))?;
    set_js_property(
        &stats,
        "periodicInteriorCount",
        &JsValue::from_f64(periodic_interior_count as f64),
    )?;
    set_js_property(&stats, "rebaseCount", &JsValue::from_f64(rebase_count as f64))?;
    set_js_property(
        &stats,
        "rebaseLimitCount",
        &JsValue::from_f64(rebase_limit_count as f64),
    )?;
    set_js_property(&stats, "blaSkipCount", &JsValue::from_f64(bla_skip_count as f64))?;
    set_js_property(&stats, "blaStepCount", &JsValue::from_f64(bla_step_count as f64))?;
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
    set_js_property(&stats, "preview", &JsValue::from_bool(render_mode == "preview"))?;
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
        array.push(object.as_ref());
    }
    Ok(array)
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
    let mut best_unresolved = failure_result64(max_iter, 0.0, true, 0, 0, false, 0, 0);
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
                let cycle_delta2 = cycle_delta_re * cycle_delta_re + cycle_delta_im * cycle_delta_im;
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
            break;
        }
    }

    if glitch || iter < max_iter {
        return failure_result64(
            max_iter,
            mag2,
            true,
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
        let allowed = RENDER_SERIES_ERROR_SCALE * tile_radius.max(exact_mag).max(estimate_mag).max(f64::MIN_POSITIVE);
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
    let cols = if rect.width >= rect.height * 1.5 { 8 } else { 4 };
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
                best_x: 0.0,
                best_y: 0.0,
                best_survived_iter: -1,
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
) {
    let cols = if rect.width >= rect.height * 1.5 { 8 } else { 4 };
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
    if survived_iter as i32 > cluster.best_survived_iter {
        cluster.best_survived_iter = survived_iter as i32;
        cluster.best_x = screen_x;
        cluster.best_y = screen_y;
    }
}

fn build_render_unresolved_clusters(clusters: &[ClusterAccumulator64], rect: Rect64) -> Vec<UnresolvedCluster64> {
    let radius_px = 0.5f64.max(rect.width.hypot(rect.height) * 0.25);
    let mut result: Vec<UnresolvedCluster64> = clusters
        .iter()
        .filter(|cluster| cluster.count > 0)
        .map(|cluster| UnresolvedCluster64 {
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
            bounds: cluster.bounds,
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
    let mut candidates: Vec<BoundaryCandidate64> = Vec::new();
    let mut boundary_dampened_count = 0u32;

    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            if unresolved_mask[index] != 0 || escaped_mask[index] == 0 {
                continue;
            }
            let edge_strength = render_edge_strength_at(index, x, y, width, height, smooth_values, escaped_mask, unresolved_mask);
            edge_strengths[index] = edge_strength as f32;
            if edge_strength >= RENDER_AA_EDGE_THRESHOLD {
                candidates.push(BoundaryCandidate64 {
                    index,
                    edge_strength,
                });
            }
        }
    }

    candidates.sort_by(|a, b| b.edge_strength.total_cmp(&a.edge_strength));
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

    if !contexts.is_empty() {
        let pixel_step_x = rect.width / width as f64;
        let pixel_step_y = rect.height / height as f64;
        for candidate_index in 0..aa_limit {
            let candidate = candidates[candidate_index];
            let x = candidate.index % width;
            let y = candidate.index / width;
            let screen_x = (rect.x + rect.width - 0.5 * pixel_step_x).min(rect.x + (x as f64 + 0.5) * pixel_step_x);
            let screen_y = (rect.y + rect.height - 0.5 * pixel_step_y).min(rect.y + (y as f64 + 0.5) * pixel_step_y);
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
        }
    }

    for index in 0..edge_strengths.len() {
        let edge_strength = edge_strengths[index] as f64;
        if edge_strength <= 0.0 || escaped_mask[index] == 0 || unresolved_mask[index] != 0 {
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

fn render_edge_strength_at(
    index: usize,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
    smooth_values: &[f32],
    escaped_mask: &[u8],
    unresolved_mask: &[u8],
) -> f64 {
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
            max_smooth_delta = f64::max(max_smooth_delta, (smooth - smooth_values[neighbor_index] as f64).abs());
        } else if neighbor_escaped || escaped {
            max_smooth_delta = f64::max(max_smooth_delta, RENDER_SMOOTH_DELTA_HIGH);
        }
    }
    let smooth_edge = clamp01((max_smooth_delta - RENDER_SMOOTH_DELTA_LOW) / (RENDER_SMOOTH_DELTA_HIGH - RENDER_SMOOTH_DELTA_LOW));
    clamp01(smooth_edge + if classification_change { RENDER_CLASSIFICATION_EDGE_BOOST } else { 0.0 })
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
            color_for_render_result(selection.result.iter, max_iter, selection.result.mag2, palette)
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

fn fill_render_unresolved_preview(buffer: &mut [u8], unresolved_mask: &mut [u8], width: usize, height: usize) {
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

fn render_tile_probe_offsets(rect: Rect64, screen_x: f64, screen_y: f64, pixel_span: f64) -> Vec<Complex64> {
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

fn write_render_color_for_smooth(buffer: &mut [u8], offset: usize, interior: bool, smooth: f64, palette: &[u8]) {
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
    iter as f64 + 1.0 - (mag2.max(4.0).ln() * RENDER_SMOOTH_LOG_SCALE).max(1e-12).ln() * RENDER_INV_LN2
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
