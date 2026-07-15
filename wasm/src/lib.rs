use astro_float::{BigFloat, RoundingMode, Sign};
use js_sys::{Float64Array, Object, Reflect, Uint8ClampedArray};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
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

fn run_two_mul_sparse_orbit(
    cr: &BigFloat,
    ci: &BigFloat,
    max_iter: u32,
    p: usize,
    check_interval: u32,
) -> OrbitResult {
    let mut zr = BigFloat::from_word(0, p);
    let mut zi = BigFloat::from_word(0, p);
    let four = BigFloat::from_word(4, p);
    let mut checkpoint_re = zr.clone();
    let mut checkpoint_im = zi.clone();
    let mut checkpoint_iter = 0u32;
    let mut orbit_re = Vec::with_capacity(max_iter as usize + 1);
    let mut orbit_im = Vec::with_capacity(max_iter as usize + 1);
    orbit_re.push(0.0);
    orbit_im.push(0.0);

    for i in 0..max_iter {
        let next_iter = i + 1;
        let (next_re, next_im) = step_two_mul(&zr, &zi, cr, ci, p);
        zr = next_re;
        zi = next_im;

        orbit_re.push(bf_to_f64(&zr));
        orbit_im.push(bf_to_f64(&zi));

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
    mut orbit_re: Vec<f64>,
    mut orbit_im: Vec<f64>,
) -> OrbitResult {
    let mut zr = start_re.clone();
    let mut zi = start_im.clone();
    let mut iter = start_iter;

    let checkpoint_len = start_iter as usize + 1;
    orbit_re.truncate(checkpoint_len);
    orbit_im.truncate(checkpoint_len);

    while iter < target_iter {
        let (next_re, next_im) = step_two_mul(&zr, &zi, cr, ci, p);
        zr = next_re;
        zi = next_im;
        iter += 1;

        orbit_re.push(bf_to_f64(&zr));
        orbit_im.push(bf_to_f64(&zi));

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

fn build_reference_value(orbit: OrbitResult) -> Result<JsValue, JsValue> {
    let object = Object::new();
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

#[derive(Clone, Copy)]
struct ComplexBall64 {
    center: Complex64,
    radius: f64,
}

#[derive(Clone, Copy)]
struct AttractingCycle64 {
    root: Complex64,
    period: u32,
}

#[derive(Clone)]
struct CachedRenderReference {
    screen_x: f64,
    screen_y: f64,
    orbit_re: Rc<Vec<f64>>,
    orbit_im: Rc<Vec<f64>>,
    orbit_limit: usize,
    interior_radius: f64,
    series_coefficients: Rc<SeriesCoefficientCache64>,
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
    tail: Vec<SeriesSnapshot64>,
}

struct SeriesCoefficientCache64 {
    degree: usize,
    steps: usize,
    coeff_re: Vec<f64>,
    coeff_im: Vec<f64>,
}

impl SeriesCoefficientCache64 {
    fn coefficients(&self, step: usize, degree: usize) -> Option<(&[f64], &[f64])> {
        if step > self.steps || degree > self.degree {
            return None;
        }
        let stride = self.degree + 1;
        let start = step * stride;
        Some((
            &self.coeff_re[start..start + degree + 1],
            &self.coeff_im[start..start + degree + 1],
        ))
    }
}

#[derive(Clone)]
struct SeriesSnapshot64 {
    iter: usize,
    coeff_re: Vec<f64>,
    coeff_im: Vec<f64>,
}

#[derive(Clone, Copy)]
struct PixelResult64 {
    iter: u32,
    rebase_count: u32,
    periodic_interior: bool,
    attracting_cycle: Option<AttractingCycle64>,
    interior_probe_failed: bool,
    phase: f64,
    distance_pixels: f64,
}

#[derive(Clone, Copy)]
struct ScaledDerivative64 {
    value: Complex64,
    log_scale: f64,
    valid: bool,
}

#[derive(Clone, Copy)]
struct OrbitSample64 {
    iter: u32,
    z: Complex64,
    derivative: ScaledDerivative64,
}

struct OrbitHistory64 {
    samples: [OrbitSample64; RENDER_FIELDLINE_HISTORY],
    len: usize,
    next: usize,
}

#[derive(Clone, Copy)]
struct LinearColor64 {
    r: f64,
    g: f64,
    b: f64,
}

#[derive(Clone, Copy)]
struct PaletteFilterStats64 {
    palette_footprint_count: u32,
    palette_footprint_fallback_count: u32,
    palette_filtered_count: u32,
    palette_proxy_count: u32,
    max_palette_footprint: f64,
    max_palette_proxy_lod: f64,
}

struct RenderPaletteCache {
    colors: Vec<u8>,
    linear_colors: Vec<f64>,
    linear_prefix: Vec<f64>,
    srgb_to_linear: Vec<f64>,
}

thread_local! {
    static RENDER_REFERENCE: RefCell<Option<CachedRenderReference>> = const { RefCell::new(None) };
    static RENDER_PALETTE_CACHE: Rc<RenderPaletteCache> = {
        let colors = create_render_palette();
        let srgb_to_linear = create_render_srgb_to_linear_lut();
        let linear_colors: Vec<f64> = colors.iter().map(|value| srgb_to_linear[*value as usize]).collect();
        let linear_prefix = create_render_palette_linear_prefix(&linear_colors);
        Rc::new(RenderPaletteCache { colors, linear_colors, linear_prefix, srgb_to_linear })
    };
}

const RENDER_SERIES_MAX_SKIP: usize = 8192;
const RENDER_SERIES_CACHE_DEGREE: usize = 12;
const RENDER_MAX_SERIES_TILE_RADIUS: f64 = 1e-3;
const RENDER_SERIES_ERROR_SCALE: f64 = 2.9e-2;
const RENDER_SERIES_SKIP_SATURATION: f64 = 0.7;
const RENDER_SERIES_PIXEL_ERROR_SCALE: f64 = 0.25;
const RENDER_INTERIOR_R: u8 = 4;
const RENDER_INTERIOR_G: u8 = 8;
const RENDER_INTERIOR_B: u8 = 16;
const RENDER_PALETTE_SIZE: usize = 2048;
const RENDER_PALETTE_FILTER_LOW: f64 = 0.25;
const RENDER_PALETTE_FILTER_HIGH: f64 = 0.5;
const RENDER_CLASSIC_PHASE_SHIFT: f64 = 0.05;
const RENDER_CLASSIC_PHASE_TO_CYCLE: f64 = 0.5;
const RENDER_CLASSIC_X: [f64; 6] = [0.0, 0.16, 0.42, 0.6425, 0.8575, 1.0];
const RENDER_CLASSIC_RGB: [[f64; 3]; 6] = [
    [0.0, 7.0 / 255.0, 100.0 / 255.0],
    [32.0 / 255.0, 107.0 / 255.0, 203.0 / 255.0],
    [237.0 / 255.0, 1.0, 1.0],
    [1.0, 170.0 / 255.0, 0.0],
    [0.0, 2.0 / 255.0, 0.0],
    [0.0, 7.0 / 255.0, 100.0 / 255.0],
];
const RENDER_CLASSIC_SLOPES: [[f64; 6]; 3] = [
    [0.0, 1.194787893926148, 0.5635740336807239, 0.0, 0.0, 0.0],
    [
        2.5342957695898876,
        2.3452143441398312,
        0.0,
        -2.016353034611317,
        0.0,
        0.41279669762641907,
    ],
    [
        3.1874416433239956,
        1.248935402381812,
        0.0,
        0.0,
        0.0,
        3.848920257588989,
    ],
];
const RENDER_FIELDLINE_BACKSHIFT: usize = 14;
const RENDER_FIELDLINE_HISTORY: usize = RENDER_FIELDLINE_BACKSHIFT + 1;
const RENDER_FIELDLINE_ITERATIONS: usize = 10;
const RENDER_FIELDLINE_INTENSITY: f64 = 0.25;
const RENDER_FIELDLINE_WEIGHTS: [f64; RENDER_FIELDLINE_ITERATIONS] = [
    0.11152039795440076,
    0.10878938741684663,
    0.1061252562905306,
    0.10352636677304,
    0.10099112116992197,
    0.09851796091248424,
    0.0961053655996487,
    0.093751852063269,
    0.09145597345633741,
    0.08921631836352062,
];
const RENDER_FIELDLINE_BAILOUT: f64 = 1000.0;
const RENDER_FIELDLINE_BAILOUT_SQUARED: f64 = RENDER_FIELDLINE_BAILOUT * RENDER_FIELDLINE_BAILOUT;
const RENDER_FIELDLINE_MAX_REFINEMENT: usize = 8;
const RENDER_DERIVATIVE_RESCALE_HIGH: f64 = 1e120;
const RENDER_DERIVATIVE_RESCALE_FACTOR: f64 = 1e-120;
const RENDER_DERIVATIVE_LOG_RESCALE: f64 = 120.0 * std::f64::consts::LN_10;
const RENDER_BOUNDARY_DISTANCE_PIXELS: f64 = 0.75;
const RENDER_BOUNDARY_CENTER_ESCAPE_LIMIT: u32 = 64;
const RENDER_BOUNDARY_SAMPLE_OFFSETS: [(f64, f64); 4] = [
    (-0.375, -0.125),
    (0.125, -0.375),
    (0.375, 0.125),
    (-0.125, 0.375),
];
const RENDER_INV_LN2: f64 = std::f64::consts::LOG2_E;
const RENDER_REFERENCE_INTERIOR_RADIUS_SAFETY: f64 = 0.90;
const RENDER_REFERENCE_INTERIOR_MIN_BLOCK_SIZE: usize = 16;
const RENDER_INTERIOR_PROBE_MAX_ITER: u32 = 256;
const RENDER_INTERIOR_NEWTON_MAX_STEPS: usize = 16;
const RENDER_INTERIOR_PROBE_FAILURE_COOLDOWN: u32 = 32;
const RENDER_CLAMPED_SCALE_PIXEL_SPAN_THRESHOLD: f64 = 1e-290;

#[wasm_bindgen]
pub fn reset_render_cache() {
    RENDER_REFERENCE.with(|reference| *reference.borrow_mut() = None);
}

#[wasm_bindgen]
pub fn set_render_reference(
    screen_x: f64,
    screen_y: f64,
    max_iter_bounded_radius: f64,
    orbit_re: Float64Array,
    orbit_im: Float64Array,
) {
    let orbit_re = orbit_re.to_vec();
    let orbit_im = orbit_im.to_vec();
    let orbit_limit = orbit_re
        .iter()
        .zip(&orbit_im)
        .take_while(|(re, im)| re.is_finite() && im.is_finite())
        .count()
        .saturating_sub(1);
    let series_coefficients = Rc::new(build_series_coefficient_cache64(
        &orbit_re,
        &orbit_im,
        RENDER_SERIES_CACHE_DEGREE,
        RENDER_SERIES_MAX_SKIP,
    ));
    let reference = CachedRenderReference {
        screen_x,
        screen_y,
        orbit_re: Rc::new(orbit_re),
        orbit_im: Rc::new(orbit_im),
        orbit_limit,
        interior_radius: max_iter_bounded_radius,
        series_coefficients,
    };
    RENDER_REFERENCE.with(|resident| *resident.borrow_mut() = Some(reference));
}

#[wasm_bindgen]
pub fn render_tile(
    tile_id: &str,
    revision: u32,
    rect_x: f64,
    rect_y: f64,
    rect_width: f64,
    rect_height: f64,
    pixel_span: f64,
    max_iter: u32,
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
    let sample_width = width + 2;
    let sample_height = height + 2;
    let sample_rect = Rect64 {
        x: rect.x - 1.0,
        y: rect.y - 1.0,
        width: sample_width as f64,
        height: sample_height as f64,
    };
    let mut context = build_render_context(sample_rect, pixel_span)?;
    let series_started = js_sys::Date::now();
    ensure_render_series(&mut context, RENDER_SERIES_CACHE_DEGREE, pixel_span);
    let series_build_ms = js_sys::Date::now() - series_started;
    let series_skip = context
        .series
        .as_ref()
        .map_or(0, |series| series.skip as u32);
    let palette = RENDER_PALETTE_CACHE.with(Rc::clone);
    let sample_count = sample_width * sample_height;
    let mut sample_rgba = vec![0u8; sample_count * 4];
    let mut certified_interior_mask = vec![0u8; sample_count];
    let mut escaped_pixels = 0u32;
    let block_cert_started = js_sys::Date::now();
    let certified_interior_count = certify_render_blocks64(
        &mut certified_interior_mask,
        &mut sample_rgba,
        sample_width,
        sample_height,
        sample_rect,
        pixel_span,
        max_iter,
        &context,
        palette.colors.as_slice(),
    );
    let block_cert_ms = js_sys::Date::now() - block_cert_started;
    let mut periodic_interior_count = 0u32;
    let mut cap_hit_unknown_count = 0u32;
    let mut rebase_count = 0u32;
    let mut scalar_iterations = 0u64;
    let mut escaped_mask = vec![0u8; sample_count];
    let mut escape_iters = vec![max_iter; sample_count];
    let mut phase_values = vec![f32::NAN; sample_count];
    let mut distance_pixels = vec![f32::NAN; sample_count];
    let mut palette_footprints = vec![-1f32; sample_count];
    let screen_xs: Vec<f64> = (0..sample_width)
        .map(|px| sample_rect.x + px as f64 + 0.5)
        .collect();
    let screen_ys: Vec<f64> = (0..sample_height)
        .map(|py| sample_rect.y + py as f64 + 0.5)
        .collect();
    let mut adjacent_interior = false;
    let mut adjacent_cycle = None;
    let mut interior_probe_cooldown = 0u32;
    let pixel_loop_started = js_sys::Date::now();
    for py in 0..sample_height {
        let screen_y = screen_ys[py];
        let scan_start = if py & 1 == 0 {
            0
        } else {
            sample_width.saturating_sub(1)
        };
        for scan_offset in 0..sample_width {
            let px = if py & 1 == 0 {
                scan_start + scan_offset
            } else {
                scan_start - scan_offset
            };
            let pixel_index = py * sample_width + px;
            let is_output_pixel = px > 0 && px <= width && py > 0 && py <= height;
            if certified_interior_mask[pixel_index] != 0 {
                if is_output_pixel {
                    periodic_interior_count += 1;
                }
                adjacent_interior = true;
                adjacent_cycle = None;
                interior_probe_cooldown = 0;
                continue;
            }
            let screen_x = screen_xs[px];
            let should_probe_interior = adjacent_interior && interior_probe_cooldown == 0;
            let result = render_pixel64(
                screen_x,
                screen_y,
                pixel_span,
                max_iter,
                should_probe_interior,
                adjacent_cycle,
                &context,
            );
            if !result.periodic_interior {
                scalar_iterations += result.iter.saturating_sub(series_skip) as u64;
            }
            let offset = pixel_index * 4;
            if result.iter < max_iter {
                escaped_mask[pixel_index] = 1;
                escape_iters[pixel_index] = result.iter;
                phase_values[pixel_index] = result.phase as f32;
                distance_pixels[pixel_index] = result.distance_pixels.min(f32::MAX as f64) as f32;
                if is_output_pixel {
                    escaped_pixels += 1;
                }
            } else if is_output_pixel {
                if result.periodic_interior {
                    periodic_interior_count += 1;
                } else {
                    cap_hit_unknown_count += 1;
                }
            }
            adjacent_interior = result.iter >= max_iter;
            adjacent_cycle = result.attracting_cycle;
            if result.periodic_interior || result.iter < max_iter {
                interior_probe_cooldown = 0;
            } else if result.interior_probe_failed {
                interior_probe_cooldown = RENDER_INTERIOR_PROBE_FAILURE_COOLDOWN;
            } else {
                interior_probe_cooldown = interior_probe_cooldown.saturating_sub(1);
            }
            if is_output_pixel {
                rebase_count += result.rebase_count;
            }
            write_render_color_for_phase(
                &mut sample_rgba,
                offset,
                result.iter >= max_iter,
                result.phase,
                palette.as_ref(),
            );
        }
    }
    let pixel_loop_ms = js_sys::Date::now() - pixel_loop_started;

    let post_process_started = js_sys::Date::now();
    let palette_footprint_fallback_count = estimate_render_palette_footprints_from_smooth(
        &mut palette_footprints,
        &phase_values,
        &escaped_mask,
        sample_width,
        sample_height,
    );
    let mut palette_filter_stats = apply_render_bandlimited_palette_shading(
        &mut sample_rgba,
        &phase_values,
        &palette_footprints,
        &escaped_mask,
        sample_width,
        sample_height,
        palette.as_ref(),
    );
    palette_filter_stats.palette_footprint_fallback_count = palette_footprint_fallback_count;

    for py in 1..=height {
        for px in 1..=width {
            let index = py * sample_width + px;
            let escaped = escaped_mask[index] != 0;
            let mixed_neighbor = [
                index - 1,
                index + 1,
                index - sample_width,
                index + sample_width,
            ]
            .into_iter()
            .any(|neighbor| (escaped_mask[neighbor] != 0) != escaped);
            let near_boundary = escaped
                && (distance_pixels[index] as f64).is_finite()
                && distance_pixels[index] > 0.0
                && (distance_pixels[index] as f64) < RENDER_BOUNDARY_DISTANCE_PIXELS;
            // Only an escaping center sample can safely use the expensive rotated-grid
            // coverage pass: its sub-samples normally escape quickly. Interior center
            // samples may require the full iteration cap four more times, and darkening
            // those centers is also what makes an exterior fringe look wider than it is.
            if !escaped
                || !mixed_neighbor
                || !near_boundary
                || escape_iters[index] > RENDER_BOUNDARY_CENTER_ESCAPE_LIMIT
            {
                continue;
            }
            let screen_x = screen_xs[px];
            let screen_y = screen_ys[py];
            let coverage_max_iter = escape_iters[index].saturating_add(32).min(max_iter);
            let mut color = LinearColor64 {
                r: 0.0,
                g: 0.0,
                b: 0.0,
            };
            for (dx, dy) in RENDER_BOUNDARY_SAMPLE_OFFSETS {
                let sample = render_pixel64(
                    screen_x + dx,
                    screen_y + dy,
                    pixel_span,
                    coverage_max_iter,
                    true,
                    None,
                    &context,
                );
                let sample_color = if sample.iter >= coverage_max_iter {
                    render_interior_linear_color()
                } else {
                    render_phase_linear_color(sample.phase, palette.as_ref())
                };
                color.r += sample_color.r * 0.25;
                color.g += sample_color.g * 0.25;
                color.b += sample_color.b * 0.25;
            }
            write_render_linear_color(&mut sample_rgba, index * 4, color);
        }
    }

    let mut rgba = vec![0u8; width * height * 4];
    for py in 0..height {
        let source = ((py + 1) * sample_width + 1) * 4;
        let target = py * width * 4;
        rgba[target..target + width * 4].copy_from_slice(&sample_rgba[source..source + width * 4]);
    }
    let elapsed_ms = js_sys::Date::now() - started;
    let post_process_ms = js_sys::Date::now() - post_process_started;
    build_render_tile_value(
        tile_id,
        revision,
        rect,
        width,
        height,
        rgba,
        elapsed_ms,
        escaped_pixels,
        periodic_interior_count,
        cap_hit_unknown_count,
        rebase_count,
        scalar_iterations,
        series_skip,
        certified_interior_count,
        series_build_ms,
        block_cert_ms,
        pixel_loop_ms,
        post_process_ms,
        palette_filter_stats,
    )
}

#[allow(clippy::too_many_arguments)]
fn certify_render_blocks64(
    mask: &mut [u8],
    rgba: &mut [u8],
    width: usize,
    height: usize,
    rect: Rect64,
    pixel_span: f64,
    max_iter: u32,
    context: &RenderContext,
    palette: &[u8],
) -> u32 {
    if width == 0 || height == 0 {
        return 0;
    }
    let mut certified = 0u32;
    let _ = certify_render_block64(
        mask,
        rgba,
        width,
        rect,
        pixel_span,
        max_iter,
        context,
        palette,
        0,
        0,
        width,
        height,
        &mut certified,
        None,
    );
    certified
}

#[allow(clippy::too_many_arguments)]
fn certify_render_block64(
    mask: &mut [u8],
    rgba: &mut [u8],
    stride: usize,
    rect: Rect64,
    pixel_span: f64,
    max_iter: u32,
    context: &RenderContext,
    palette: &[u8],
    x0: usize,
    y0: usize,
    block_width: usize,
    block_height: usize,
    certified: &mut u32,
    interior_hint: Option<AttractingCycle64>,
) -> Option<AttractingCycle64> {
    if block_width == 0 || block_height == 0 {
        return interior_hint;
    }

    let (block_is_certified, block_hint) = certifies_render_block64(
        context,
        rect,
        pixel_span,
        max_iter,
        x0,
        y0,
        block_width,
        block_height,
        interior_hint,
    );
    if block_is_certified {
        fill_certified_render_block64(
            mask,
            rgba,
            stride,
            x0,
            y0,
            block_width,
            block_height,
            max_iter,
            palette,
        );
        *certified += (block_width * block_height) as u32;
        return block_hint.or(interior_hint);
    }

    if block_width <= RENDER_REFERENCE_INTERIOR_MIN_BLOCK_SIZE
        && block_height <= RENDER_REFERENCE_INTERIOR_MIN_BLOCK_SIZE
    {
        return block_hint.or(interior_hint);
    }

    let child_hint = block_hint.or(interior_hint);
    if block_width >= block_height && block_width > RENDER_REFERENCE_INTERIOR_MIN_BLOCK_SIZE {
        let left_width = block_width / 2;
        let right_width = block_width - left_width;
        let left_hint = certify_render_block64(
            mask,
            rgba,
            stride,
            rect,
            pixel_span,
            max_iter,
            context,
            palette,
            x0,
            y0,
            left_width,
            block_height,
            certified,
            child_hint,
        );
        certify_render_block64(
            mask,
            rgba,
            stride,
            rect,
            pixel_span,
            max_iter,
            context,
            palette,
            x0 + left_width,
            y0,
            right_width,
            block_height,
            certified,
            left_hint.or(child_hint),
        )
    } else if block_height > RENDER_REFERENCE_INTERIOR_MIN_BLOCK_SIZE {
        let top_height = block_height / 2;
        let bottom_height = block_height - top_height;
        let top_hint = certify_render_block64(
            mask,
            rgba,
            stride,
            rect,
            pixel_span,
            max_iter,
            context,
            palette,
            x0,
            y0,
            block_width,
            top_height,
            certified,
            child_hint,
        );
        certify_render_block64(
            mask,
            rgba,
            stride,
            rect,
            pixel_span,
            max_iter,
            context,
            palette,
            x0,
            y0 + top_height,
            block_width,
            bottom_height,
            certified,
            top_hint.or(child_hint),
        )
    } else {
        child_hint
    }
}

#[allow(clippy::too_many_arguments)]
fn certifies_render_block64(
    context: &RenderContext,
    rect: Rect64,
    pixel_span: f64,
    max_iter: u32,
    x0: usize,
    y0: usize,
    block_width: usize,
    block_height: usize,
    interior_hint: Option<AttractingCycle64>,
) -> (bool, Option<AttractingCycle64>) {
    let screen_x = rect.x + x0 as f64 + block_width as f64 * 0.5;
    let screen_y = rect.y + y0 as f64 + block_height as f64 * 0.5;
    let block_radius = (block_width as f64).hypot(block_height as f64) * 0.5 * pixel_span;
    if !screen_x.is_finite() || !screen_y.is_finite() || !block_radius.is_finite() {
        return (false, interior_hint);
    }
    let reference = &context.reference;
    let center_delta =
        (screen_x - reference.screen_x).hypot(screen_y - reference.screen_y) * pixel_span;
    let covered_radius = reference.interior_radius * RENDER_REFERENCE_INTERIOR_RADIUS_SAFETY;
    if covered_radius > 0.0 && center_delta + block_radius <= covered_radius {
        return (true, interior_hint);
    }

    if block_width <= RENDER_REFERENCE_INTERIOR_MIN_BLOCK_SIZE
        && block_height <= RENDER_REFERENCE_INTERIOR_MIN_BLOCK_SIZE
    {
        return (false, interior_hint);
    }
    let screen_dx = screen_x - reference.screen_x;
    let screen_dy = screen_y - reference.screen_y;
    let c_delta_re = screen_dx * pixel_span;
    let c_delta_im = screen_dy * pixel_span;
    let Some((parameter, center_error)) = render_parameter_ball64(
        screen_dx,
        screen_dy,
        c_delta_re,
        c_delta_im,
        pixel_span,
        &reference.orbit_re,
        &reference.orbit_im,
    ) else {
        return (false, interior_hint);
    };
    let parameter_radius = outward_sum_nonnegative64(&[center_error, block_radius]);
    if let Some(cycle) =
        certify_attracting_interior64(parameter, parameter_radius, max_iter, interior_hint)
    {
        return (true, Some(cycle));
    }

    // A parent can be too wide for one proof while its center is well inside a
    // hyperbolic component.  Preserve only the cycle as a hint; every child
    // still constructs and verifies its own full parameter ball.
    let center_cycle =
        certify_attracting_interior64(parameter, center_error, max_iter, interior_hint);
    (false, center_cycle.or(interior_hint))
}

#[cfg(test)]
fn certify_parameter_block64(
    parameter: Complex64,
    center_error: f64,
    block_radius: f64,
    max_iter: u32,
) -> bool {
    if !center_error.is_finite() || !block_radius.is_finite() || block_radius < 0.0 {
        return false;
    }
    let parameter_radius = outward_sum_nonnegative64(&[center_error, block_radius]);
    certify_attracting_interior64(parameter, parameter_radius, max_iter, None).is_some()
}

#[allow(clippy::too_many_arguments)]
fn fill_certified_render_block64(
    mask: &mut [u8],
    rgba: &mut [u8],
    stride: usize,
    x0: usize,
    y0: usize,
    block_width: usize,
    block_height: usize,
    _max_iter: u32,
    _palette: &[u8],
) {
    for y in y0..(y0 + block_height) {
        for x in x0..(x0 + block_width) {
            let index = y * stride + x;
            mask[index] = 1;
            write_render_interior_color(rgba, index * 4);
        }
    }
}

#[wasm_bindgen]
pub fn estimate_max_iter_bounded_radius(
    escaped_at: u32,
    max_iter: u32,
    orbit_re: Float64Array,
    orbit_im: Float64Array,
) -> f64 {
    let orbit_re = orbit_re.to_vec();
    let orbit_im = orbit_im.to_vec();
    estimate_max_iter_bounded_radius64(escaped_at, max_iter, &orbit_re, &orbit_im)
}

fn estimate_max_iter_bounded_radius64(
    escaped_at: u32,
    max_iter: u32,
    orbit_re: &[f64],
    orbit_im: &[f64],
) -> f64 {
    if escaped_at < max_iter || max_iter < 2 {
        return 0.0;
    }
    let limit = (max_iter as usize).min(orbit_re.len()).min(orbit_im.len());
    if limit < max_iter as usize {
        return 0.0;
    }

    let survives = |radius: f64| -> bool {
        let mut error = 0.0f64;
        for index in 0..limit.saturating_sub(1) {
            let re = next_up_nonnegative(orbit_re[index].abs());
            let im = next_up_nonnegative(orbit_im[index].abs());
            let orbit_norm = next_up_nonnegative(re.hypot(im));
            if !orbit_norm.is_finite() || orbit_norm + error > 2.0 {
                return false;
            }
            let linear = next_up_nonnegative(2.0 * orbit_norm + error);
            error = next_up_nonnegative(next_up_nonnegative(linear * error) + radius);
            if !error.is_finite() {
                return false;
            }
        }
        true
    };

    let mut low = 0.0f64;
    let mut high = 4.0f64;
    for _ in 0..64 {
        let middle = low + (high - low) * 0.5;
        if survives(middle) {
            low = middle;
        } else {
            high = middle;
        }
    }
    if low.is_finite() && low > 0.0 {
        low * 0.9
    } else {
        0.0
    }
}

fn next_up_nonnegative(value: f64) -> f64 {
    if value.is_nan() || value == f64::INFINITY {
        return value;
    }
    if value == 0.0 {
        return f64::from_bits(1);
    }
    f64::from_bits(value.to_bits() + 1)
}

fn build_render_context(rect: Rect64, pixel_span: f64) -> Result<RenderContext, JsValue> {
    let reference = RENDER_REFERENCE
        .with(|resident| resident.borrow().clone())
        .ok_or_else(|| JsValue::from_str("render reference is not set"))?;
    let radius = render_tile_radius(rect, reference.screen_x, reference.screen_y, pixel_span);
    let probes =
        render_tile_probe_offsets(rect, reference.screen_x, reference.screen_y, pixel_span);
    Ok(RenderContext {
        reference,
        radius,
        probes,
        series: None,
    })
}

fn build_render_tile_value(
    tile_id: &str,
    revision: u32,
    rect: Rect64,
    width: usize,
    height: usize,
    rgba: Vec<u8>,
    elapsed_ms: f64,
    escaped_pixels: u32,
    periodic_interior_count: u32,
    cap_hit_unknown_count: u32,
    rebase_count: u32,
    scalar_iterations: u64,
    series_skip: u32,
    certified_interior_count: u32,
    series_build_ms: f64,
    block_cert_ms: f64,
    pixel_loop_ms: f64,
    post_process_ms: f64,
    palette_filter_stats: PaletteFilterStats64,
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

    let stats = Object::new();
    set_js_property(&stats, "elapsedMs", &JsValue::from_f64(elapsed_ms))?;
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
        "capHitUnknownCount",
        &JsValue::from_f64(cap_hit_unknown_count as f64),
    )?;
    set_js_property(
        &stats,
        "rebaseCount",
        &JsValue::from_f64(rebase_count as f64),
    )?;
    set_js_property(
        &stats,
        "scalarIterations",
        &JsValue::from_f64(scalar_iterations as f64),
    )?;
    set_js_property(&stats, "seriesSkip", &JsValue::from_f64(series_skip as f64))?;
    set_js_property(
        &stats,
        "certifiedInteriorCount",
        &JsValue::from_f64(certified_interior_count as f64),
    )?;
    set_js_property(&stats, "seriesBuildMs", &JsValue::from_f64(series_build_ms))?;
    set_js_property(&stats, "blockCertMs", &JsValue::from_f64(block_cert_ms))?;
    set_js_property(&stats, "pixelLoopMs", &JsValue::from_f64(pixel_loop_ms))?;
    set_js_property(&stats, "postProcessMs", &JsValue::from_f64(post_process_ms))?;
    set_js_property(
        &stats,
        "paletteFootprintCount",
        &JsValue::from_f64(palette_filter_stats.palette_footprint_count as f64),
    )?;
    set_js_property(
        &stats,
        "paletteFootprintFallbackCount",
        &JsValue::from_f64(palette_filter_stats.palette_footprint_fallback_count as f64),
    )?;
    set_js_property(
        &stats,
        "paletteFilteredCount",
        &JsValue::from_f64(palette_filter_stats.palette_filtered_count as f64),
    )?;
    set_js_property(
        &stats,
        "paletteProxyCount",
        &JsValue::from_f64(palette_filter_stats.palette_proxy_count as f64),
    )?;
    set_js_property(
        &stats,
        "maxPaletteFootprint",
        &JsValue::from_f64(palette_filter_stats.max_palette_footprint),
    )?;
    set_js_property(
        &stats,
        "maxPaletteProxyLod",
        &JsValue::from_f64(palette_filter_stats.max_palette_proxy_lod),
    )?;
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

fn render_pixel64(
    screen_x: f64,
    screen_y: f64,
    pixel_span: f64,
    max_iter: u32,
    probe_interior: bool,
    interior_hint: Option<AttractingCycle64>,
    context: &RenderContext,
) -> PixelResult64 {
    let screen_dx = screen_x - context.reference.screen_x;
    let screen_dy = screen_y - context.reference.screen_y;
    let c_re = screen_dx * pixel_span;
    let c_im = screen_dy * pixel_span;
    if probe_interior {
        if let Some((parameter, parameter_error)) = render_parameter_ball64(
            screen_dx,
            screen_dy,
            c_re,
            c_im,
            pixel_span,
            &context.reference.orbit_re,
            &context.reference.orbit_im,
        ) {
            if let Some(cycle) =
                certify_attracting_interior64(parameter, parameter_error, max_iter, interior_hint)
            {
                return PixelResult64 {
                    iter: max_iter,
                    rebase_count: 0,
                    periodic_interior: true,
                    attracting_cycle: Some(cycle),
                    interior_probe_failed: false,
                    phase: f64::NAN,
                    distance_pixels: f64::NAN,
                };
            }
        }
    }
    let mut result = perturb64(
        c_re,
        c_im,
        &context.reference.orbit_re,
        &context.reference.orbit_im,
        context.reference.orbit_limit,
        max_iter,
        pixel_span,
        context.series.as_ref().expect("series plan is initialized"),
    );
    result.interior_probe_failed = probe_interior;
    result
}

fn render_parameter_ball64(
    screen_dx: f64,
    screen_dy: f64,
    c_delta_re: f64,
    c_delta_im: f64,
    pixel_span: f64,
    orbit_re: &[f64],
    orbit_im: &[f64],
) -> Option<(Complex64, f64)> {
    let reference_re = *orbit_re.get(1)?;
    let reference_im = *orbit_im.get(1)?;
    let center = Complex64 {
        re: reference_re + c_delta_re,
        im: reference_im + c_delta_im,
    };
    if !complex_is_finite64(center) || !pixel_span.is_finite() {
        return None;
    }

    // orbit[1] is the high-precision view center truncated to f64. The remaining
    // terms cover the screen-offset subtraction, the f64 pixel-span conversion,
    // the offset multiplication, and the final addition. Full ULPs (rather than
    // half ULPs) keep this enclosure conservative across native and Wasm builds.
    let component_error = |screen_delta: f64, delta: f64, reference: f64, value: f64| {
        let clamped_scale_error = if pixel_span.abs() < RENDER_CLAMPED_SCALE_PIXEL_SPAN_THRESHOLD {
            // scaleToNumber clamps URL scales above 1e300. Enclose the whole
            // f64 screen delta at that depth so the true, smaller delta remains
            // inside the parameter ball even when the URL coordinate is not
            // representable by f64.
            outward_mul_nonnegative64(screen_delta.abs(), pixel_span.abs())
        } else {
            0.0
        };
        outward_sum_nonnegative64(&[
            outward_mul_nonnegative64(2.0, ulp_bound64(reference)),
            outward_mul_nonnegative64(
                4.0,
                outward_mul_nonnegative64(ulp_bound64(screen_delta), pixel_span.abs()),
            ),
            outward_mul_nonnegative64(
                8.0,
                outward_mul_nonnegative64(screen_delta.abs(), ulp_bound64(pixel_span)),
            ),
            outward_mul_nonnegative64(4.0, ulp_bound64(delta)),
            outward_mul_nonnegative64(4.0, ulp_bound64(value)),
            clamped_scale_error,
        ])
    };
    let error_re = component_error(screen_dx, c_delta_re, reference_re, center.re);
    let error_im = component_error(screen_dy, c_delta_im, reference_im, center.im);
    let radius = outward_hypot_nonnegative64(error_re, error_im);
    if radius.is_finite() {
        Some((center, radius))
    } else {
        None
    }
}

fn certify_attracting_interior64(
    c: Complex64,
    c_error: f64,
    max_iter: u32,
    hint: Option<AttractingCycle64>,
) -> Option<AttractingCycle64> {
    if !complex_is_finite64(c) || !c_error.is_finite() || c_error < 0.0 {
        return None;
    }
    let probe_limit = max_iter.min(RENDER_INTERIOR_PROBE_MAX_ITER);
    if let Some(cycle) = hint {
        if let Some(proven) = certify_hint_attracting_interior64(c, c_error, probe_limit, cycle) {
            return Some(proven);
        }
    }

    let mut z = Complex64 { re: 0.0, im: 0.0 };
    let mut minimum_mag2 = f64::INFINITY;

    for period in 1..=probe_limit {
        z = complex_add64(complex_square64(z), c);
        if !complex_is_finite64(z) || z.re.abs().max(z.im.abs()) > 2.0 {
            return None;
        }
        let mag2 = z.re * z.re + z.im * z.im;
        if !mag2.is_finite() || mag2 >= minimum_mag2 {
            continue;
        }
        minimum_mag2 = mag2;

        let Some(mut root) = newton_periodic_point64(c, z, period) else {
            continue;
        };
        let reduced_period = reduce_period64(c, root, period);
        if reduced_period != period {
            let Some(reduced_root) = newton_periodic_point64(c, root, reduced_period) else {
                continue;
            };
            root = reduced_root;
        }
        if prove_attracting_cycle64(c, c_error, root, reduced_period) {
            return Some(AttractingCycle64 {
                root,
                period: reduced_period,
            });
        }
    }
    None
}

fn certify_hint_attracting_interior64(
    c: Complex64,
    c_error: f64,
    probe_limit: u32,
    hint: AttractingCycle64,
) -> Option<AttractingCycle64> {
    if hint.period == 0 || hint.period > probe_limit {
        return None;
    }
    // The hint already came from a rigorous attracting-cycle proof. Newton
    // continuation followed by a fresh ball proof is sufficient at the new
    // parameter: replaying the critical orbit and reducing the known period
    // only repeated O(period) work for every adjacent pixel.
    let root = newton_periodic_point64(c, hint.root, hint.period)?;
    prove_attracting_cycle64(c, c_error, root, hint.period).then_some(AttractingCycle64 {
        root,
        period: hint.period,
    })
}

fn newton_periodic_point64(c: Complex64, initial: Complex64, period: u32) -> Option<Complex64> {
    let mut z = initial;
    for _ in 0..RENDER_INTERIOR_NEWTON_MAX_STEPS {
        let (mapped, derivative) = periodic_map_and_derivative64(c, z, period)?;
        let residual = complex_sub64(mapped, z);
        let jacobian = complex_sub64(derivative, Complex64 { re: 1.0, im: 0.0 });
        let residual_norm = complex_abs_upper64(residual);
        if residual_norm <= 64.0 * f64::EPSILON * complex_abs_upper64(z).max(1.0) {
            break;
        }
        let correction = complex_div64(residual, jacobian)?;
        z = complex_sub64(z, correction);
        if !complex_is_finite64(z) {
            return None;
        }
    }
    let (mapped, _) = periodic_map_and_derivative64(c, z, period)?;
    let residual = complex_abs_upper64(complex_sub64(mapped, z));
    if residual.is_finite() && residual <= 1e-7 * complex_abs_upper64(z).max(1.0) {
        Some(z)
    } else {
        None
    }
}

fn reduce_period64(c: Complex64, root: Complex64, period: u32) -> u32 {
    let tolerance = 1e-7 * complex_abs_upper64(root).max(1.0);
    for divisor in 1..period {
        if period % divisor != 0 {
            continue;
        }
        let Some((mapped, _)) = periodic_map_and_derivative64(c, root, divisor) else {
            continue;
        };
        if complex_abs_upper64(complex_sub64(mapped, root)) <= tolerance {
            return divisor;
        }
    }
    period
}

fn periodic_map_and_derivative64(
    c: Complex64,
    initial: Complex64,
    period: u32,
) -> Option<(Complex64, Complex64)> {
    let mut z = initial;
    let mut derivative = Complex64 { re: 1.0, im: 0.0 };
    for _ in 0..period {
        derivative = complex_scale64(complex_mul64(z, derivative), 2.0);
        z = complex_add64(complex_square64(z), c);
        if !complex_is_finite64(z) || !complex_is_finite64(derivative) {
            return None;
        }
    }
    Some((z, derivative))
}

fn prove_attracting_cycle64(c: Complex64, c_error: f64, root: Complex64, period: u32) -> bool {
    if period == 0 || !complex_is_finite64(root) {
        return false;
    }
    let Some((mapped, _)) = periodic_map_and_derivative64(c, root, period) else {
        return false;
    };
    let residual = complex_abs_upper64(complex_sub64(mapped, root));
    let root_roundoff = outward_hypot_nonnegative64(ulp_bound64(root.re), ulp_bound64(root.im));
    let mut radius = outward_mul_nonnegative64(
        2.0,
        c_error
            .max(outward_mul_nonnegative64(32.0, root_roundoff))
            .max(outward_mul_nonnegative64(4.0, residual)),
    );
    if !radius.is_finite() || radius <= 0.0 {
        return false;
    }
    let parameter = ComplexBall64 {
        center: c,
        radius: c_error,
    };

    for _ in 0..48 {
        let mut state = ComplexBall64 {
            center: root,
            radius,
        };
        let mut derivative_bound = 1.0;
        for _ in 0..period {
            let state_norm =
                outward_sum_nonnegative64(&[complex_abs_upper64(state.center), state.radius]);
            derivative_bound = outward_mul_nonnegative64(
                derivative_bound,
                outward_mul_nonnegative64(2.0, state_norm),
            );
            state = ball_add64(ball_mul64(state, state), parameter);
        }
        if !ball_is_finite64(state) || !derivative_bound.is_finite() {
            return false;
        }

        let (mapped_delta, mapped_delta_roundoff) = complex_sub_with_error64(state.center, root);
        let mapped_radius = outward_sum_nonnegative64(&[
            complex_abs_upper64(mapped_delta),
            mapped_delta_roundoff,
            state.radius,
        ]);
        if mapped_radius < radius && derivative_bound < 1.0 {
            return true;
        }
        if derivative_bound >= 1.0 || !mapped_radius.is_finite() {
            return false;
        }
        let contraction_slack = 1.0 - derivative_bound;
        let fixed_ball_estimate = outward_mul_nonnegative64(
            1.125,
            next_up_nonnegative(mapped_radius / contraction_slack),
        );
        let next_radius = outward_mul_nonnegative64(1.5, radius).max(fixed_ball_estimate);
        if !next_radius.is_finite() || next_radius <= radius || next_radius > 0.25 {
            return false;
        }
        radius = next_radius;
    }
    false
}

fn ball_add64(left: ComplexBall64, right: ComplexBall64) -> ComplexBall64 {
    let (center, roundoff) = complex_add_with_error64(left.center, right.center);
    ComplexBall64 {
        center,
        radius: outward_sum_nonnegative64(&[left.radius, right.radius, roundoff]),
    }
}

fn ball_mul64(left: ComplexBall64, right: ComplexBall64) -> ComplexBall64 {
    let (center, roundoff) = complex_mul_with_error64(left.center, right.center);
    let left_norm = complex_abs_upper64(left.center);
    let right_norm = complex_abs_upper64(right.center);
    ComplexBall64 {
        center,
        radius: outward_sum_nonnegative64(&[
            outward_mul_nonnegative64(left_norm, right.radius),
            outward_mul_nonnegative64(right_norm, left.radius),
            outward_mul_nonnegative64(left.radius, right.radius),
            roundoff,
        ]),
    }
}

fn ball_is_finite64(value: ComplexBall64) -> bool {
    complex_is_finite64(value.center) && value.radius.is_finite() && value.radius >= 0.0
}

fn complex_add_with_error64(left: Complex64, right: Complex64) -> (Complex64, f64) {
    let center = complex_add64(left, right);
    let error = outward_hypot_nonnegative64(ulp_bound64(center.re), ulp_bound64(center.im));
    (center, error)
}

fn complex_sub_with_error64(left: Complex64, right: Complex64) -> (Complex64, f64) {
    let center = complex_sub64(left, right);
    let error = outward_hypot_nonnegative64(ulp_bound64(center.re), ulp_bound64(center.im));
    (center, error)
}

fn complex_mul_with_error64(left: Complex64, right: Complex64) -> (Complex64, f64) {
    let ac = left.re * right.re;
    let bd = left.im * right.im;
    let ad = left.re * right.im;
    let bc = left.im * right.re;
    let center = Complex64 {
        re: ac - bd,
        im: ad + bc,
    };
    let error_re =
        outward_sum_nonnegative64(&[ulp_bound64(ac), ulp_bound64(bd), ulp_bound64(center.re)]);
    let error_im =
        outward_sum_nonnegative64(&[ulp_bound64(ad), ulp_bound64(bc), ulp_bound64(center.im)]);
    (center, outward_hypot_nonnegative64(error_re, error_im))
}

fn complex_add64(left: Complex64, right: Complex64) -> Complex64 {
    Complex64 {
        re: left.re + right.re,
        im: left.im + right.im,
    }
}

fn complex_sub64(left: Complex64, right: Complex64) -> Complex64 {
    Complex64 {
        re: left.re - right.re,
        im: left.im - right.im,
    }
}

fn complex_mul64(left: Complex64, right: Complex64) -> Complex64 {
    Complex64 {
        re: left.re * right.re - left.im * right.im,
        im: left.re * right.im + left.im * right.re,
    }
}

fn complex_square64(value: Complex64) -> Complex64 {
    Complex64 {
        re: value.re * value.re - value.im * value.im,
        im: 2.0 * value.re * value.im,
    }
}

fn complex_scale64(value: Complex64, factor: f64) -> Complex64 {
    Complex64 {
        re: value.re * factor,
        im: value.im * factor,
    }
}

fn complex_div64(numerator: Complex64, denominator: Complex64) -> Option<Complex64> {
    let norm = denominator.re * denominator.re + denominator.im * denominator.im;
    if !norm.is_finite() || norm <= f64::MIN_POSITIVE {
        return None;
    }
    let value = Complex64 {
        re: (numerator.re * denominator.re + numerator.im * denominator.im) / norm,
        im: (numerator.im * denominator.re - numerator.re * denominator.im) / norm,
    };
    complex_is_finite64(value).then_some(value)
}

fn complex_is_finite64(value: Complex64) -> bool {
    value.re.is_finite() && value.im.is_finite()
}

fn complex_abs_upper64(value: Complex64) -> f64 {
    outward_hypot_nonnegative64(value.re.abs(), value.im.abs())
}

fn outward_hypot_nonnegative64(left: f64, right: f64) -> f64 {
    next_up_nonnegative(next_up_nonnegative(left).hypot(next_up_nonnegative(right)))
}

fn outward_sum_nonnegative64(values: &[f64]) -> f64 {
    values.iter().fold(0.0, |sum, value| {
        next_up_nonnegative(sum + next_up_nonnegative(*value))
    })
}

fn outward_mul_nonnegative64(left: f64, right: f64) -> f64 {
    next_up_nonnegative(left * right)
}

fn ulp_bound64(value: f64) -> f64 {
    if !value.is_finite() {
        return f64::INFINITY;
    }
    let upper = (next_up64(value) - value).abs();
    let lower = (value - next_down64(value)).abs();
    next_up_nonnegative(upper.max(lower))
}

fn next_up64(value: f64) -> f64 {
    if value.is_nan() || value == f64::INFINITY {
        return value;
    }
    if value == 0.0 {
        return f64::from_bits(1);
    }
    if value > 0.0 {
        f64::from_bits(value.to_bits() + 1)
    } else {
        f64::from_bits(value.to_bits() - 1)
    }
}

fn next_down64(value: f64) -> f64 {
    if value.is_nan() || value == f64::NEG_INFINITY {
        return value;
    }
    if value == 0.0 {
        return -f64::from_bits(1);
    }
    if value > 0.0 {
        f64::from_bits(value.to_bits() - 1)
    } else {
        f64::from_bits(value.to_bits() + 1)
    }
}

fn ensure_render_series(context: &mut RenderContext, series_degree: usize, pixel_span: f64) {
    if context.series.is_none() {
        context.series = Some(build_series_plan_from_cache64(
            &context.reference.orbit_re,
            &context.reference.orbit_im,
            &context.reference.series_coefficients,
            series_degree,
            RENDER_SERIES_MAX_SKIP,
            context.radius,
            pixel_span,
            &context.probes,
        ));
    }
}

fn perturb64(
    c_re: f64,
    c_im: f64,
    orbit_re: &[f64],
    orbit_im: &[f64],
    orbit_limit: usize,
    max_iter: u32,
    pixel_span: f64,
    series: &SeriesPlan64,
) -> PixelResult64 {
    let mut dz_re = 0.0;
    let mut dz_im = 0.0;
    let mut iter = 0u32;
    let mut ref_index = 0usize;
    let mut rebase_count = 0u32;
    let mut derivative = ScaledDerivative64::zero();
    let mut history = OrbitHistory64::new();
    let parameter = Complex64 {
        re: orbit_re.get(1).copied().unwrap_or(0.0) + c_re,
        im: orbit_im.get(1).copied().unwrap_or(0.0) + c_im,
    };

    if series.skip > 0 {
        let dz = evaluate_series64(series, c_re, c_im);
        dz_re = dz.re;
        dz_im = dz.im;
        derivative =
            ScaledDerivative64::from_complex(evaluate_series_derivative64(series, c_re, c_im));
        iter = series.skip as u32;
        ref_index = series.skip;
    }

    let limit = (max_iter as usize)
        .min(orbit_limit)
        .min(orbit_re.len().saturating_sub(1))
        .min(orbit_im.len().saturating_sub(1));
    debug_assert!(ref_index <= limit);

    while iter <= max_iter && ref_index <= limit {
        let ref_re = orbit_re[ref_index];
        let ref_im = orbit_im[ref_index];
        let z_re = ref_re + dz_re;
        let z_im = ref_im + dz_im;
        if !z_re.is_finite() || !z_im.is_finite() {
            return failed_pixel_result64(iter, rebase_count);
        }
        let z = Complex64 { re: z_re, im: z_im };
        history.push(OrbitSample64 {
            iter,
            z,
            derivative,
        });
        let z_norm = z_re.abs().max(z_im.abs());
        if z_norm > 2.0 {
            let history =
                complete_series_history64(history, series, c_re, c_im, orbit_re, orbit_im);
            return finish_escaped_pixel64(
                iter,
                z,
                derivative,
                parameter,
                pixel_span,
                history,
                rebase_count,
            );
        }
        if iter >= max_iter {
            return PixelResult64 {
                iter: max_iter,
                rebase_count,
                periodic_interior: false,
                attracting_cycle: None,
                interior_probe_failed: false,
                phase: f64::NAN,
                distance_pixels: f64::NAN,
            };
        }

        let dz_norm_before_step = dz_re.abs().max(dz_im.abs());
        let mut step_ref_re = ref_re;
        let mut step_ref_im = ref_im;
        if ref_index > 0 && (z_norm < dz_norm_before_step || ref_index == limit) {
            dz_re = z_re;
            dz_im = z_im;
            ref_index = 0;
            step_ref_re = orbit_re[0];
            step_ref_im = orbit_im[0];
            rebase_count += 1;
        }

        derivative.step_finite(z);
        let dz2_re = dz_re * dz_re - dz_im * dz_im;
        let dz2_im = 2.0 * dz_re * dz_im;
        let two_ref_dz_re = 2.0 * (step_ref_re * dz_re - step_ref_im * dz_im);
        let two_ref_dz_im = 2.0 * (step_ref_re * dz_im + step_ref_im * dz_re);
        dz_re = two_ref_dz_re + dz2_re + c_re;
        dz_im = two_ref_dz_im + dz2_im + c_im;
        iter += 1;
        ref_index += 1;
    }
    PixelResult64 {
        iter: max_iter,
        rebase_count,
        periodic_interior: false,
        attracting_cycle: None,
        interior_probe_failed: false,
        phase: f64::NAN,
        distance_pixels: f64::NAN,
    }
}

fn complete_series_history64(
    history: OrbitHistory64,
    series: &SeriesPlan64,
    c_re: f64,
    c_im: f64,
    orbit_re: &[f64],
    orbit_im: &[f64],
) -> OrbitHistory64 {
    if history.len >= RENDER_FIELDLINE_HISTORY || series.tail.is_empty() {
        return history;
    }
    let mut combined = OrbitHistory64::new();
    for snapshot in &series.tail {
        let delta = evaluate_series_coefficients64(
            &snapshot.coeff_re,
            &snapshot.coeff_im,
            series.degree,
            c_re,
            c_im,
        );
        let z = Complex64 {
            re: orbit_re.get(snapshot.iter).copied().unwrap_or(f64::NAN) + delta.re,
            im: orbit_im.get(snapshot.iter).copied().unwrap_or(f64::NAN) + delta.im,
        };
        if !complex_is_finite64(z) {
            continue;
        }
        combined.push(OrbitSample64 {
            iter: snapshot.iter as u32,
            z,
            derivative: ScaledDerivative64::from_complex(
                evaluate_series_coefficients_derivative64(
                    &snapshot.coeff_re,
                    &snapshot.coeff_im,
                    series.degree,
                    c_re,
                    c_im,
                ),
            ),
        });
    }
    for index in 0..history.len {
        if let Some(sample) = history.get(index) {
            combined.push_unique(sample);
        }
    }
    combined
}

fn failed_pixel_result64(iter: u32, rebase_count: u32) -> PixelResult64 {
    PixelResult64 {
        iter,
        rebase_count,
        periodic_interior: false,
        attracting_cycle: None,
        interior_probe_failed: false,
        phase: f64::NAN,
        distance_pixels: f64::NAN,
    }
}

#[allow(clippy::too_many_arguments)]
fn finish_escaped_pixel64(
    escape_iter: u32,
    mut z: Complex64,
    mut derivative: ScaledDerivative64,
    parameter: Complex64,
    pixel_span: f64,
    mut history: OrbitHistory64,
    rebase_count: u32,
) -> PixelResult64 {
    let mut post_iter = escape_iter;
    for _ in 0..RENDER_FIELDLINE_MAX_REFINEMENT {
        if z.re * z.re + z.im * z.im >= RENDER_FIELDLINE_BAILOUT_SQUARED {
            break;
        }
        derivative.step_finite(z);
        z = complex_add64(complex_square64(z), parameter);
        post_iter += 1;
        if !complex_is_finite64(z) {
            break;
        }
        history.push(OrbitSample64 {
            iter: post_iter,
            z,
            derivative,
        });
    }

    let radius_squared = z.re * z.re + z.im * z.im;
    let log_radius = 0.5 * radius_squared.ln();
    let (smooth, nu_frac) = render_continuous_iteration_from_log64(post_iter, log_radius);
    let base_phase = smooth.max(1e-9).ln();
    let fieldline =
        render_fieldline64(&history, (-nu_frac).clamp(0.0, 1.0), pixel_span).unwrap_or(0.0);
    let phase = base_phase + RENDER_FIELDLINE_INTENSITY * fieldline;
    let distance_pixels =
        render_distance_pixels_from_log64(log_radius, derivative, pixel_span).unwrap_or(f64::NAN);
    PixelResult64 {
        iter: escape_iter,
        rebase_count,
        periodic_interior: false,
        attracting_cycle: None,
        interior_probe_failed: false,
        phase,
        distance_pixels,
    }
}

#[cfg(test)]
fn render_continuous_iteration64(iter: u32, radius: f64) -> (f64, f64) {
    render_continuous_iteration_from_log64(iter, radius.ln())
}

fn render_continuous_iteration_from_log64(iter: u32, log_radius: f64) -> (f64, f64) {
    let raw_fraction = if log_radius.is_finite() && log_radius > 0.0 {
        -((log_radius / RENDER_FIELDLINE_BAILOUT.ln())
            .max(f64::MIN_POSITIVE)
            .ln()
            * RENDER_INV_LN2)
    } else {
        0.0
    };
    // Match Continuous_iter_pp: keep the Catmull-Rom fraction in (-1, 0]
    // even for a rare one-step overshoot beyond M², while preserving ν.
    let correction = (-raw_fraction).max(0.0);
    let integral_correction = correction.floor();
    let nu_frac = -(correction - integral_correction);
    (iter as f64 - integral_correction + nu_frac, nu_frac)
}

impl ScaledDerivative64 {
    fn zero() -> Self {
        Self {
            value: Complex64 { re: 0.0, im: 0.0 },
            log_scale: 0.0,
            valid: true,
        }
    }

    fn from_complex(value: Complex64) -> Self {
        let mut result = Self {
            value,
            log_scale: 0.0,
            valid: complex_is_finite64(value),
        };
        result.renormalize();
        result
    }

    #[cfg(test)]
    fn step(&mut self, z: Complex64) {
        if !self.valid || !complex_is_finite64(z) {
            self.valid = false;
            return;
        }
        self.step_finite(z);
    }

    fn step_finite(&mut self, z: Complex64) {
        if !self.valid {
            return;
        }
        // Once the derivative has been rescaled, the transformed +1 term is
        // at most 1e-120 and cannot affect a normalized finite f64 derivative.
        let additive = if self.log_scale == 0.0 { 1.0 } else { 0.0 };
        self.value = Complex64 {
            re: 2.0 * (z.re * self.value.re - z.im * self.value.im) + additive,
            im: 2.0 * (z.re * self.value.im + z.im * self.value.re),
        };
        let re_norm = self.value.re.abs();
        let im_norm = self.value.im.abs();
        if re_norm <= RENDER_DERIVATIVE_RESCALE_HIGH && im_norm <= RENDER_DERIVATIVE_RESCALE_HIGH {
            return;
        }
        if !re_norm.is_finite() || !im_norm.is_finite() {
            self.valid = false;
            return;
        }
        self.renormalize();
    }

    fn renormalize(&mut self) {
        if !self.valid {
            return;
        }
        let mut norm = self.value.re.abs().max(self.value.im.abs());
        while norm > RENDER_DERIVATIVE_RESCALE_HIGH {
            self.value = complex_scale64(self.value, RENDER_DERIVATIVE_RESCALE_FACTOR);
            self.log_scale += RENDER_DERIVATIVE_LOG_RESCALE;
            norm *= RENDER_DERIVATIVE_RESCALE_FACTOR;
        }
        self.valid = complex_is_finite64(self.value) && self.log_scale.is_finite();
    }

    fn log_abs(self) -> Option<f64> {
        if !self.valid {
            return None;
        }
        let magnitude_squared = self.value.re * self.value.re + self.value.im * self.value.im;
        (magnitude_squared.is_finite() && magnitude_squared > 0.0)
            .then_some(0.5 * magnitude_squared.ln() + self.log_scale)
    }
}

impl OrbitHistory64 {
    fn new() -> Self {
        const EMPTY: OrbitSample64 = OrbitSample64 {
            iter: 0,
            z: Complex64 { re: 0.0, im: 0.0 },
            derivative: ScaledDerivative64 {
                value: Complex64 { re: 0.0, im: 0.0 },
                log_scale: 0.0,
                valid: false,
            },
        };
        Self {
            samples: [EMPTY; RENDER_FIELDLINE_HISTORY],
            len: 0,
            next: 0,
        }
    }

    fn push(&mut self, sample: OrbitSample64) {
        self.samples[self.next] = sample;
        self.next += 1;
        if self.next == RENDER_FIELDLINE_HISTORY {
            self.next = 0;
        }
        self.len = (self.len + 1).min(RENDER_FIELDLINE_HISTORY);
    }

    fn push_unique(&mut self, sample: OrbitSample64) {
        if self.len > 0 {
            let last = if self.next == 0 {
                RENDER_FIELDLINE_HISTORY - 1
            } else {
                self.next - 1
            };
            if self.samples[last].iter == sample.iter {
                self.samples[last] = sample;
                return;
            }
        }
        self.push(sample);
    }

    fn get(&self, index: usize) -> Option<OrbitSample64> {
        if index >= self.len {
            return None;
        }
        let start = if self.len == RENDER_FIELDLINE_HISTORY {
            self.next
        } else {
            0
        };
        let slot = start + index;
        Some(
            self.samples[if slot >= RENDER_FIELDLINE_HISTORY {
                slot - RENDER_FIELDLINE_HISTORY
            } else {
                slot
            }],
        )
    }
}

fn render_fieldline64(history: &OrbitHistory64, fraction: f64, pixel_span: f64) -> Option<f64> {
    if history.len < RENDER_FIELDLINE_HISTORY {
        return None;
    }
    let pixel_span = pixel_span.abs();
    let log_pixel_span = pixel_span.ln();
    if !log_pixel_span.is_finite() {
        return None;
    }
    let mut orbit_sines = [0.0; RENDER_FIELDLINE_HISTORY];
    for (index, value) in orbit_sines.iter_mut().enumerate() {
        *value = render_bandlimited_orbit_sine64(history.get(index)?, pixel_span, log_pixel_span)?;
    }
    let x = fraction.clamp(0.0, 1.0);
    let h0 = 0.5 * x * (-x + x * x);
    let h1 = 0.5 * x * (1.0 + 4.0 * x - 3.0 * x * x);
    let h2 = 1.0 + 0.5 * x * (-5.0 * x + 3.0 * x * x);
    let h3 = 0.5 * x * (-1.0 + 2.0 * x - x * x);
    let mut fieldline = 0.0;
    for (index, weight) in RENDER_FIELDLINE_WEIGHTS.iter().enumerate() {
        fieldline += weight
            * (h0 * orbit_sines[index]
                + h1 * orbit_sines[index + 1]
                + h2 * orbit_sines[index + 2]
                + h3 * orbit_sines[index + 3]);
    }
    fieldline.is_finite().then_some(fieldline.clamp(-1.0, 1.0))
}

fn render_bandlimited_orbit_sine64(
    sample: OrbitSample64,
    pixel_span: f64,
    log_pixel_span: f64,
) -> Option<f64> {
    let z_abs_squared = sample.z.re * sample.z.re + sample.z.im * sample.z.im;
    let derivative_abs_squared = sample.derivative.value.re * sample.derivative.value.re
        + sample.derivative.value.im * sample.derivative.value.im;
    if !sample.derivative.valid
        || !z_abs_squared.is_finite()
        || z_abs_squared <= 0.0
        || !derivative_abs_squared.is_finite()
        || derivative_abs_squared <= 0.0
    {
        return None;
    }
    let cross = sample.derivative.value.im * sample.z.re - sample.derivative.value.re * sample.z.im;
    let dot = sample.derivative.value.re * sample.z.re + sample.derivative.value.im * sample.z.im;
    let direct_gradient_squared = derivative_abs_squared * pixel_span * pixel_span / z_abs_squared;
    let (gx, gy) = if sample.derivative.log_scale == 0.0 && direct_gradient_squared.is_finite() {
        let mut component_scale = pixel_span / z_abs_squared;
        if direct_gradient_squared > 1e12 {
            component_scale *= 1e6 / direct_gradient_squared.sqrt();
        }
        (component_scale * cross, component_scale * dot)
    } else {
        let log_gradient =
            0.5 * derivative_abs_squared.ln() + sample.derivative.log_scale + log_pixel_span
                - 0.5 * z_abs_squared.ln();
        if !log_gradient.is_finite() {
            return None;
        }
        let gradient = log_gradient.min(13.815_510_557_964_274).exp();
        let direction_denominator = (derivative_abs_squared * z_abs_squared).sqrt();
        if !direction_denominator.is_finite() || direction_denominator <= f64::MIN_POSITIVE {
            return None;
        }
        (
            gradient * cross / direction_denominator,
            gradient * dot / direction_denominator,
        )
    };
    let attenuation = render_pixel_sinc64(gx) * render_pixel_sinc64(gy);
    Some((sample.z.im / z_abs_squared.sqrt()) * attenuation)
}

fn render_pixel_sinc64(phase_delta: f64) -> f64 {
    let x = phase_delta.abs();
    if !x.is_finite() || x >= std::f64::consts::TAU {
        return 0.0;
    }
    if x < 1e-6 {
        return 1.0 - x * x / 24.0;
    }
    if x <= 1.0 {
        let x2 = x * x;
        return 1.0
            + x2 * (-1.0 / 24.0
                + x2 * (1.0 / 1920.0 + x2 * (-1.0 / 322_560.0 + x2 / 92_897_280.0)));
    }
    (0.5 * x).sin() / (0.5 * x)
}

#[cfg(test)]
fn render_distance_pixels64(
    z: Complex64,
    derivative: ScaledDerivative64,
    pixel_span: f64,
) -> Option<f64> {
    let radius_squared = z.re * z.re + z.im * z.im;
    render_distance_pixels_from_log64(0.5 * radius_squared.ln(), derivative, pixel_span)
}

fn render_distance_pixels_from_log64(
    log_radius: f64,
    derivative: ScaledDerivative64,
    pixel_span: f64,
) -> Option<f64> {
    let log_distance = std::f64::consts::LN_2 + log_radius + log_radius.ln()
        - derivative.log_abs()?
        - pixel_span.abs().ln();
    if !log_distance.is_finite() || log_radius <= 0.0 {
        return None;
    }
    Some(if log_distance > 27.631_021_115_928_547 {
        1e12
    } else if log_distance < -745.0 {
        0.0
    } else {
        log_distance.exp()
    })
}

fn build_series_coefficient_cache64(
    orbit_re: &[f64],
    orbit_im: &[f64],
    degree: usize,
    max_skip: usize,
) -> SeriesCoefficientCache64 {
    let stride = degree + 1;
    let available = max_skip
        .min(orbit_re.len().saturating_sub(1))
        .min(orbit_im.len().saturating_sub(1));
    let mut coeff_re = vec![0.0; stride];
    let mut coeff_im = vec![0.0; stride];
    let mut current_re = vec![0.0; stride];
    let mut current_im = vec![0.0; stride];
    let mut next_re = vec![0.0; stride];
    let mut next_im = vec![0.0; stride];
    let mut steps = 0usize;

    coeff_re.reserve(available * stride);
    coeff_im.reserve(available * stride);
    for n in 0..available {
        let zr = orbit_re[n];
        let zi = orbit_im[n];
        if !zr.is_finite() || !zi.is_finite() {
            break;
        }
        next_re.fill(0.0);
        next_im.fill(0.0);
        for k in 1..=degree {
            let ar = current_re[k];
            let ai = current_im[k];
            next_re[k] += 2.0 * (zr * ar - zi * ai);
            next_im[k] += 2.0 * (zr * ai + zi * ar);
            if k == 1 {
                next_re[k] += 1.0;
            }
            for j in 1..k {
                let br = current_re[j];
                let bi = current_im[j];
                let cr = current_re[k - j];
                let ci = current_im[k - j];
                next_re[k] += br * cr - bi * ci;
                next_im[k] += br * ci + bi * cr;
            }
        }
        coeff_re.extend_from_slice(&next_re);
        coeff_im.extend_from_slice(&next_im);
        std::mem::swap(&mut current_re, &mut next_re);
        std::mem::swap(&mut current_im, &mut next_im);
        steps += 1;
    }

    SeriesCoefficientCache64 {
        degree,
        steps,
        coeff_re,
        coeff_im,
    }
}

#[cfg(test)]
fn build_series_plan64(
    orbit_re: &[f64],
    orbit_im: &[f64],
    degree: usize,
    max_skip: usize,
    tile_radius: f64,
    pixel_span: f64,
    probes: &[Complex64],
) -> SeriesPlan64 {
    let cache = build_series_coefficient_cache64(
        orbit_re,
        orbit_im,
        degree.min(RENDER_SERIES_CACHE_DEGREE),
        max_skip,
    );
    build_series_plan_from_cache64(
        orbit_re,
        orbit_im,
        &cache,
        degree,
        max_skip,
        tile_radius,
        pixel_span,
        probes,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_series_plan_from_cache64(
    orbit_re: &[f64],
    orbit_im: &[f64],
    cache: &SeriesCoefficientCache64,
    degree: usize,
    max_skip: usize,
    tile_radius: f64,
    pixel_span: f64,
    probes: &[Complex64],
) -> SeriesPlan64 {
    let normalized_degree = degree;
    if normalized_degree > 2 {
        let mut best = build_series_plan_for_degree64(
            orbit_re,
            orbit_im,
            cache,
            2,
            max_skip,
            tile_radius,
            pixel_span,
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
                cache,
                candidate_degree,
                max_skip,
                tile_radius,
                pixel_span,
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
        cache,
        normalized_degree,
        max_skip,
        tile_radius,
        pixel_span,
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
    cache: &SeriesCoefficientCache64,
    normalized_degree: usize,
    max_skip: usize,
    tile_radius: f64,
    pixel_span: f64,
    probes: &[Complex64],
) -> SeriesPlan64 {
    let mut coeff_re = vec![0.0; normalized_degree + 1];
    let mut coeff_im = vec![0.0; normalized_degree + 1];
    let mut tail = Vec::new();
    if normalized_degree < 2
        || normalized_degree > cache.degree
        || max_skip == 0
        || !tile_radius.is_finite()
        || tile_radius <= 0.0
        || !pixel_span.is_finite()
        || pixel_span == 0.0
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
            tail,
        };
    }

    let mut probe_re = vec![0.0; probes.len()];
    let mut probe_im = vec![0.0; probes.len()];
    let mut next_probe_re = vec![0.0; probes.len()];
    let mut next_probe_im = vec![0.0; probes.len()];
    let mut skip = 0usize;
    let mut error_bound = 0.0f64;
    let error_limit = pixel_span.abs() * RENDER_SERIES_PIXEL_ERROR_SCALE;

    let available = max_skip
        .min(cache.steps)
        .min(orbit_re.len().saturating_sub(1))
        .min(orbit_im.len().saturating_sub(1));
    for n in 0..available {
        let Some((next_re, next_im)) = cache.coefficients(n + 1, normalized_degree) else {
            break;
        };
        let Some(probe_error) = probes_validate_series_step64(
            probes,
            &probe_re,
            &probe_im,
            &mut next_probe_re,
            &mut next_probe_im,
            next_re,
            next_im,
            orbit_re,
            orbit_im,
            n,
            tile_radius,
        ) else {
            break;
        };
        let derivative_lower_bound = series_derivative_lower_bound64(next_re, next_im, tile_radius);
        if derivative_lower_bound <= 0.0 {
            break;
        }
        let orbit_error_bound = next_up_nonnegative(probe_error);
        let next_error_bound =
            next_up_nonnegative(error_bound.max(orbit_error_bound / derivative_lower_bound));
        if !next_error_bound.is_finite() || next_error_bound > error_limit {
            break;
        }
        probe_re.copy_from_slice(&next_probe_re);
        probe_im.copy_from_slice(&next_probe_im);
        error_bound = next_error_bound;
        skip = n + 1;
    }

    if let Some((final_re, final_im)) = cache.coefficients(skip, normalized_degree) {
        coeff_re.copy_from_slice(final_re);
        coeff_im.copy_from_slice(final_im);
    }
    if skip > 0 {
        let first_tail_step = skip.saturating_sub(RENDER_FIELDLINE_HISTORY - 1).max(1);
        tail.reserve(skip - first_tail_step + 1);
        for step in first_tail_step..=skip {
            let Some((snapshot_re, snapshot_im)) = cache.coefficients(step, normalized_degree)
            else {
                break;
            };
            tail.push(SeriesSnapshot64 {
                iter: step,
                coeff_re: snapshot_re.to_vec(),
                coeff_im: snapshot_im.to_vec(),
            });
        }
    }

    SeriesPlan64 {
        skip,
        degree: normalized_degree,
        coeff_re,
        coeff_im,
        tail,
    }
}

fn evaluate_series64(plan: &SeriesPlan64, c_re: f64, c_im: f64) -> Complex64 {
    evaluate_series_coefficients64(&plan.coeff_re, &plan.coeff_im, plan.degree, c_re, c_im)
}

fn evaluate_series_coefficients64(
    coeff_re: &[f64],
    coeff_im: &[f64],
    degree: usize,
    c_re: f64,
    c_im: f64,
) -> Complex64 {
    if degree == 0 || coeff_re.len() <= degree || coeff_im.len() <= degree {
        return Complex64 { re: 0.0, im: 0.0 };
    }
    let mut zr = 0.0;
    let mut zi = 0.0;
    for k in (1..=degree).rev() {
        let pr = zr * c_re - zi * c_im + coeff_re[k];
        let pi = zr * c_im + zi * c_re + coeff_im[k];
        zr = pr;
        zi = pi;
    }
    Complex64 {
        re: zr * c_re - zi * c_im,
        im: zr * c_im + zi * c_re,
    }
}

fn evaluate_series_derivative64(plan: &SeriesPlan64, c_re: f64, c_im: f64) -> Complex64 {
    evaluate_series_coefficients_derivative64(
        &plan.coeff_re,
        &plan.coeff_im,
        plan.degree,
        c_re,
        c_im,
    )
}

fn evaluate_series_coefficients_derivative64(
    coeff_re: &[f64],
    coeff_im: &[f64],
    degree: usize,
    c_re: f64,
    c_im: f64,
) -> Complex64 {
    if degree == 0 || coeff_re.len() <= degree || coeff_im.len() <= degree {
        return Complex64 { re: 0.0, im: 0.0 };
    }
    let c = Complex64 { re: c_re, im: c_im };
    let mut value = Complex64 {
        re: coeff_re[degree],
        im: coeff_im[degree],
    };
    let mut derivative = Complex64 { re: 0.0, im: 0.0 };
    for k in (1..degree).rev() {
        derivative = complex_add64(complex_mul64(derivative, c), value);
        value = complex_add64(
            complex_mul64(value, c),
            Complex64 {
                re: coeff_re[k],
                im: coeff_im[k],
            },
        );
    }
    complex_add64(complex_mul64(derivative, c), value)
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
) -> Option<f64> {
    let zr = orbit_re[n];
    let zi = orbit_im[n];
    let next_ref_re = orbit_re[n + 1];
    let next_ref_im = orbit_im[n + 1];
    if !next_ref_re.is_finite() || !next_ref_im.is_finite() {
        return None;
    }
    let mut max_error = 0.0f64;

    for index in 0..probes.len() {
        let c_re = probes[index].re;
        let c_im = probes[index].im;
        let dz_re = probe_re[index];
        let dz_im = probe_im[index];
        let dz2_re = dz_re * dz_re - dz_im * dz_im;
        let dz2_im = 2.0 * dz_re * dz_im;
        let two_ref_dz_re = 2.0 * (zr * dz_re - zi * dz_im);
        let two_ref_dz_im = 2.0 * (zr * dz_im + zi * dz_re);
        let direct_re = two_ref_dz_re + dz2_re + c_re;
        let direct_im = two_ref_dz_im + dz2_im + c_im;
        if !direct_re.is_finite() || !direct_im.is_finite() {
            return None;
        }

        let z_re = next_ref_re + direct_re;
        let z_im = next_ref_im + direct_im;
        let mag2 = z_re * z_re + z_im * z_im;
        if !mag2.is_finite() || mag2 > 4.0 {
            return None;
        }

        let ref_mag2 = next_ref_re * next_ref_re + next_ref_im * next_ref_im;
        let dz_mag2 = direct_re * direct_re + direct_im * direct_im;
        if is_render_cancellation_unstable(mag2, ref_mag2, dz_mag2) {
            return None;
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
            return None;
        }
        let error = (direct_re - estimate_re).hypot(direct_im - estimate_im);
        let direct_mag = direct_re.hypot(direct_im);
        let estimate_mag = estimate_re.hypot(estimate_im);
        let allowed = RENDER_SERIES_ERROR_SCALE
            * tile_radius
                .max(direct_mag)
                .max(estimate_mag)
                .max(f64::MIN_POSITIVE);
        if !error.is_finite() || error > allowed {
            return None;
        }
        max_error = max_error.max(error);

        next_probe_re[index] = direct_re;
        next_probe_im[index] = direct_im;
    }
    Some(max_error)
}

fn series_derivative_lower_bound64(coeff_re: &[f64], coeff_im: &[f64], radius: f64) -> f64 {
    let linear = coeff_re
        .get(1)
        .copied()
        .unwrap_or(0.0)
        .hypot(coeff_im.get(1).copied().unwrap_or(0.0));
    let mut tail = 0.0f64;
    let mut power = radius;
    for degree in 2..coeff_re.len().min(coeff_im.len()) {
        let coefficient_norm = coeff_re[degree].hypot(coeff_im[degree]);
        tail = next_up_nonnegative(
            tail + next_up_nonnegative(degree as f64 * coefficient_norm * power),
        );
        power = next_up_nonnegative(power * radius);
    }
    linear - tail
}

fn is_render_cancellation_unstable(mag2: f64, ref_mag2: f64, dz_mag2: f64) -> bool {
    if !mag2.is_finite() || !ref_mag2.is_finite() || !dz_mag2.is_finite() {
        return true;
    }
    if ref_mag2 <= 1e-30 || dz_mag2 <= 1e-30 {
        return false;
    }
    dz_mag2 > ref_mag2 * 1e-4 && mag2 < ref_mag2 * 1e-20
}

fn estimate_render_palette_footprints_from_smooth(
    palette_footprints: &mut [f32],
    smooth_values: &[f32],
    escaped_mask: &[u8],
    width: usize,
    height: usize,
) -> u32 {
    let pixel_count = width * height;
    if palette_footprints.len() < pixel_count
        || smooth_values.len() < pixel_count
        || escaped_mask.len() < pixel_count
    {
        return 0;
    }
    let mut fallback_count = 0u32;
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            if escaped_mask[index] == 0 {
                continue;
            }
            let center = smooth_values[index] as f64;
            let neighbor = |nx: usize, ny: usize| -> Option<f64> {
                let neighbor_index = ny * width + nx;
                (escaped_mask[neighbor_index] != 0).then_some(smooth_values[neighbor_index] as f64)
            };
            let left = (x > 0).then(|| neighbor(x - 1, y)).flatten();
            let right = (x + 1 < width).then(|| neighbor(x + 1, y)).flatten();
            let top = (y > 0).then(|| neighbor(x, y - 1)).flatten();
            let bottom = (y + 1 < height).then(|| neighbor(x, y + 1)).flatten();
            let gradient_x = left
                .map_or(0.0, |sample| (sample - center).abs())
                .max(right.map_or(0.0, |sample| (sample - center).abs()));
            let gradient_y = top
                .map_or(0.0, |sample| (sample - center).abs())
                .max(bottom.map_or(0.0, |sample| (sample - center).abs()));
            let mut gradient = gradient_x.hypot(gradient_y);
            let mut neighbor_count =
                [left, right, top, bottom].into_iter().flatten().count() as u32;
            for (dx, dy) in [(-1isize, -1isize), (1, -1), (-1, 1), (1, 1)] {
                let nx = x as isize + dx;
                let ny = y as isize + dy;
                if nx < 0 || ny < 0 || nx >= width as isize || ny >= height as isize {
                    continue;
                }
                if let Some(sample) = neighbor(nx as usize, ny as usize) {
                    gradient =
                        gradient.max((sample - center).abs() * std::f64::consts::FRAC_1_SQRT_2);
                    neighbor_count += 1;
                }
            }
            palette_footprints[index] = if neighbor_count == 0 {
                fallback_count += 1;
                1.0
            } else if gradient.is_finite() && gradient > f64::EPSILON {
                (RENDER_CLASSIC_PHASE_TO_CYCLE * gradient) as f32
            } else {
                0.0
            };
        }
    }
    fallback_count
}

fn apply_render_bandlimited_palette_shading(
    buffer: &mut [u8],
    smooth_values: &[f32],
    palette_footprints: &[f32],
    escaped_mask: &[u8],
    width: usize,
    height: usize,
    palette: &RenderPaletteCache,
) -> PaletteFilterStats64 {
    let pixel_count = width * height;
    if pixel_count == 0
        || smooth_values.len() < pixel_count
        || palette_footprints.len() < pixel_count
    {
        return empty_render_palette_filter_stats();
    }
    let mut palette_footprint_count = 0u32;
    let mut palette_filtered_count = 0u32;
    let mut max_palette_footprint = 0.0f64;
    for index in 0..pixel_count {
        if escaped_mask[index] == 0 {
            continue;
        }
        let footprint = palette_footprints[index] as f64;
        if !footprint.is_finite() || footprint < 0.0 {
            continue;
        }
        palette_footprint_count += 1;
        max_palette_footprint = max_palette_footprint.max(footprint);

        let filter_amount = smoothstep(
            RENDER_PALETTE_FILTER_LOW,
            RENDER_PALETTE_FILTER_HIGH,
            footprint,
        );
        if filter_amount <= 0.0 {
            continue;
        }
        let offset = index * 4;
        let color = blend_render_linear_color(
            LinearColor64 {
                r: palette.srgb_to_linear[buffer[offset] as usize],
                g: palette.srgb_to_linear[buffer[offset + 1] as usize],
                b: palette.srgb_to_linear[buffer[offset + 2] as usize],
            },
            integrated_render_palette_linear_color(smooth_values[index] as f64, footprint, palette),
            filter_amount,
        );
        palette_filtered_count += 1;
        write_render_linear_color(buffer, offset, color);
    }
    PaletteFilterStats64 {
        palette_footprint_count,
        palette_footprint_fallback_count: 0,
        palette_filtered_count,
        palette_proxy_count: 0,
        max_palette_footprint,
        max_palette_proxy_lod: 0.0,
    }
}

fn empty_render_palette_filter_stats() -> PaletteFilterStats64 {
    PaletteFilterStats64 {
        palette_footprint_count: 0,
        palette_footprint_fallback_count: 0,
        palette_filtered_count: 0,
        palette_proxy_count: 0,
        max_palette_footprint: 0.0,
        max_palette_proxy_lod: 0.0,
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

fn write_render_color_for_phase(
    buffer: &mut [u8],
    offset: usize,
    interior: bool,
    phase: f64,
    palette: &RenderPaletteCache,
) {
    if interior {
        write_render_interior_color(buffer, offset);
        return;
    }
    write_render_linear_color(buffer, offset, render_phase_linear_color(phase, palette));
}

fn write_render_interior_color(buffer: &mut [u8], offset: usize) {
    buffer[offset] = RENDER_INTERIOR_R;
    buffer[offset + 1] = RENDER_INTERIOR_G;
    buffer[offset + 2] = RENDER_INTERIOR_B;
    buffer[offset + 3] = 255;
}

fn render_interior_linear_color() -> LinearColor64 {
    LinearColor64 {
        r: srgb_to_linear(RENDER_INTERIOR_R as f64 / 255.0),
        g: srgb_to_linear(RENDER_INTERIOR_G as f64 / 255.0),
        b: srgb_to_linear(RENDER_INTERIOR_B as f64 / 255.0),
    }
}

fn create_render_palette() -> Vec<u8> {
    // Fractalshades' classic palette anchors, used by P04-deep_expmap.
    // https://github.com/GBillotey/Fractalshades/blob/master/src/fractalshades/colors/colormap_templates.py
    let mut palette = vec![0u8; RENDER_PALETTE_SIZE * 3];
    for index in 0..RENDER_PALETTE_SIZE {
        let cycle = index as f64 / RENDER_PALETTE_SIZE as f64;
        let t = if cycle <= 0.5 {
            cycle * 2.0
        } else {
            (1.0 - cycle) * 2.0
        };
        let offset = index * 3;
        palette[offset] = clamp_byte(255.0 * render_classic_pchip_channel(t, 0));
        palette[offset + 1] = clamp_byte(255.0 * render_classic_pchip_channel(t, 1));
        palette[offset + 2] = clamp_byte(255.0 * render_classic_pchip_channel(t, 2));
    }
    palette
}

fn render_classic_pchip_channel(t: f64, channel: usize) -> f64 {
    let channel = channel.min(2);
    let t = t.clamp(0.0, 1.0);
    let segment = (0..5)
        .find(|index| t <= RENDER_CLASSIC_X[index + 1])
        .unwrap_or(4);
    let h = RENDER_CLASSIC_X[segment + 1] - RENDER_CLASSIC_X[segment];
    let u = (t - RENDER_CLASSIC_X[segment]) / h;
    let u2 = u * u;
    let u3 = u2 * u;
    let value = (2.0 * u3 - 3.0 * u2 + 1.0) * RENDER_CLASSIC_RGB[segment][channel]
        + (u3 - 2.0 * u2 + u) * h * RENDER_CLASSIC_SLOPES[channel][segment]
        + (-2.0 * u3 + 3.0 * u2) * RENDER_CLASSIC_RGB[segment + 1][channel]
        + (u3 - u2) * h * RENDER_CLASSIC_SLOPES[channel][segment + 1];
    value.clamp(0.0, 1.0)
}

fn create_render_srgb_to_linear_lut() -> Vec<f64> {
    (0..=255)
        .map(|value| srgb_to_linear(value as f64 / 255.0))
        .collect()
}

fn create_render_palette_linear_prefix(linear_palette: &[f64]) -> Vec<f64> {
    let mut prefix = vec![0.0; (RENDER_PALETTE_SIZE + 1) * 3];
    for index in 0..RENDER_PALETTE_SIZE {
        let source = index * 3;
        let previous = index * 3;
        let next = (index + 1) * 3;
        prefix[next] = prefix[previous] + linear_palette[source] / RENDER_PALETTE_SIZE as f64;
        prefix[next + 1] =
            prefix[previous + 1] + linear_palette[source + 1] / RENDER_PALETTE_SIZE as f64;
        prefix[next + 2] =
            prefix[previous + 2] + linear_palette[source + 2] / RENDER_PALETTE_SIZE as f64;
    }
    prefix
}

fn integrated_render_palette_linear_color(
    phase: f64,
    footprint: f64,
    palette: &RenderPaletteCache,
) -> LinearColor64 {
    let width = footprint.max(f64::EPSILON);
    let center = render_phase_cycle_position(phase);
    let low = center - width * 0.5;
    let high = center + width * 0.5;
    let linear_r = (render_palette_integral(high, 0, palette)
        - render_palette_integral(low, 0, palette))
        / width;
    let linear_g = (render_palette_integral(high, 1, palette)
        - render_palette_integral(low, 1, palette))
        / width;
    let linear_b = (render_palette_integral(high, 2, palette)
        - render_palette_integral(low, 2, palette))
        / width;
    LinearColor64 {
        r: linear_r,
        g: linear_g,
        b: linear_b,
    }
}

fn render_phase_cycle_position(phase: f64) -> f64 {
    (phase - RENDER_CLASSIC_PHASE_SHIFT) * RENDER_CLASSIC_PHASE_TO_CYCLE
}

fn render_phase_linear_color(phase: f64, palette: &RenderPaletteCache) -> LinearColor64 {
    let cycle = render_phase_cycle_position(phase).rem_euclid(1.0);
    let scaled = cycle * RENDER_PALETTE_SIZE as f64;
    let low = scaled.floor() as usize % RENDER_PALETTE_SIZE;
    let high = (low + 1) % RENDER_PALETTE_SIZE;
    let blend = scaled - scaled.floor();
    let low_offset = low * 3;
    let high_offset = high * 3;
    LinearColor64 {
        r: palette.linear_colors[low_offset]
            + (palette.linear_colors[high_offset] - palette.linear_colors[low_offset]) * blend,
        g: palette.linear_colors[low_offset + 1]
            + (palette.linear_colors[high_offset + 1] - palette.linear_colors[low_offset + 1])
                * blend,
        b: palette.linear_colors[low_offset + 2]
            + (palette.linear_colors[high_offset + 2] - palette.linear_colors[low_offset + 2])
                * blend,
    }
}

fn render_palette_integral(position: f64, channel: usize, palette: &RenderPaletteCache) -> f64 {
    let cycle = position.floor();
    let fraction = position - cycle;
    let scaled = fraction * RENDER_PALETTE_SIZE as f64;
    let index = (scaled.floor() as usize).min(RENDER_PALETTE_SIZE - 1);
    let remainder = scaled - index as f64;
    let cycle_integral = palette.linear_prefix[RENDER_PALETTE_SIZE * 3 + channel];
    let prefix = palette.linear_prefix[index * 3 + channel];
    let sample = palette.linear_colors[index * 3 + channel];
    cycle * cycle_integral + prefix + sample * remainder / RENDER_PALETTE_SIZE as f64
}

fn blend_render_linear_color(from: LinearColor64, to: LinearColor64, amount: f64) -> LinearColor64 {
    let t = clamp01(amount);
    LinearColor64 {
        r: from.r + (to.r - from.r) * t,
        g: from.g + (to.g - from.g) * t,
        b: from.b + (to.b - from.b) * t,
    }
}

fn write_render_linear_color(buffer: &mut [u8], offset: usize, color: LinearColor64) {
    buffer[offset] = linear_channel_to_byte(color.r);
    buffer[offset + 1] = linear_channel_to_byte(color.g);
    buffer[offset + 2] = linear_channel_to_byte(color.b);
    buffer[offset + 3] = 255;
}

fn linear_channel_to_byte(value: f64) -> u8 {
    clamp_byte(linear_to_srgb(value) * 255.0)
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

fn smoothstep(low: f64, high: f64, value: f64) -> f64 {
    if high <= low {
        return if value >= high { 1.0 } else { 0.0 };
    }
    let t = clamp01((value - low) / (high - low));
    t * t * (3.0 - 2.0 * t)
}

fn clamp_byte(value: f64) -> u8 {
    if !value.is_finite() {
        return 0;
    }
    value.max(0.0).min(255.0).round() as u8
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
    let bits = precision_bits.max(estimate_precision_bits("1", max_iter));
    let p = precision(bits);
    let cr = parse_float(center_re, bits)?;
    let ci = parse_float(center_im, bits)?;
    let orbit = run_two_mul_sparse_orbit(&cr, &ci, max_iter, p, DEFAULT_REFERENCE_CHECK_INTERVAL);
    build_reference_value(orbit)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_series() -> SeriesPlan64 {
        SeriesPlan64 {
            skip: 0,
            degree: 0,
            coeff_re: Vec::new(),
            coeff_im: Vec::new(),
            tail: Vec::new(),
        }
    }

    #[test]
    fn finite_large_delta_is_an_escape_not_a_numeric_failure() {
        let result = perturb64(
            1e150,
            0.0,
            &[0.0, 0.0],
            &[0.0, 0.0],
            1,
            8,
            1.0,
            &no_series(),
        );
        assert!(result.iter < 8);
    }

    #[test]
    fn carries_on_after_a_short_reference_orbit() {
        let result = perturb64(
            -1.0,
            0.0,
            &[0.0, 1.0],
            &[0.0, 0.0],
            1,
            32,
            1.0,
            &no_series(),
        );
        assert_eq!(result.iter, 32);
        assert!(result.rebase_count > 0);
    }

    #[test]
    fn component_norm_does_not_underflow() {
        let re: f64 = 1e-300;
        let im: f64 = -5e-301;
        assert_eq!(re * re + im * im, 0.0);
        assert!(re.abs().max(im.abs()) > 0.0);
    }

    #[test]
    fn bounded_radius_is_conservative_for_known_cases() {
        let zeros = vec![0.0; 65];
        let bounded = estimate_max_iter_bounded_radius64(64, 64, &zeros, &zeros);
        assert!(bounded > 0.0);
        assert!(bounded <= 0.25);
        assert_eq!(
            estimate_max_iter_bounded_radius64(2, 64, &[0.0, 1.0], &[0.0, 0.0]),
            0.0
        );
    }

    #[test]
    fn series_plan_uses_validated_skip() {
        let orbit_re = vec![0.0; 65];
        let orbit_im = vec![0.0; 65];
        let pixel_span = 1e-6;
        let plan = build_series_plan64(
            &orbit_re,
            &orbit_im,
            12,
            64,
            1e-4,
            pixel_span,
            &[Complex64 { re: 1e-4, im: 0.0 }],
        );
        assert!(plan.skip <= 64);
        assert!(plan.coeff_re.iter().all(|value| value.is_finite()));
        assert!(plan.coeff_im.iter().all(|value| value.is_finite()));
    }

    fn periodic_target_parameter(screen_x: f64, screen_y: f64) -> Complex64 {
        let center = Complex64 {
            re: "-1.76854392069529079967435552147905380619071646671631558221721367158317146672961987405313343e0"
                .parse()
                .unwrap(),
            im: "-7.30078926394540958134620082008361635055501804364889844988162485821612638368665062006680955e-4"
                .parse()
                .unwrap(),
        };
        let scale: f64 = "5.16675442717597361866334085449662625942340146464132181028971962586112670232698885953242576e3"
            .parse()
            .unwrap();
        let pixel_span = 3.5 / scale / 1912.0;
        Complex64 {
            re: center.re + (screen_x - 956.0) * pixel_span,
            im: center.im + (screen_y - 474.0) * pixel_span,
        }
    }

    fn critical_orbit_value(c: Complex64, period: u32) -> Complex64 {
        let mut z = Complex64 { re: 0.0, im: 0.0 };
        for _ in 0..period {
            z = complex_add64(complex_square64(z), c);
        }
        z
    }

    #[test]
    fn proves_period_three_and_six_target_interior_points() {
        for (screen_x, screen_y, period) in [(1216.5, 448.5, 3), (704.5, 448.5, 6)] {
            let c = periodic_target_parameter(screen_x, screen_y);
            let initial = critical_orbit_value(c, period);
            let root = newton_periodic_point64(c, initial, period).unwrap();
            assert_eq!(reduce_period64(c, root, period), period);
            assert!(prove_attracting_cycle64(c, 1e-14, root, period));
            assert!(certify_attracting_interior64(c, 1e-14, 5000, None).is_some());
        }
    }

    #[test]
    fn does_not_certify_target_center_that_escapes_near_iteration_226() {
        let c = periodic_target_parameter(956.0, 474.0);
        assert!(certify_attracting_interior64(c, 1e-14, 5000, None).is_none());
    }

    #[test]
    fn rejects_a_cycle_when_parameter_uncertainty_crosses_its_component() {
        let c = periodic_target_parameter(704.5, 448.5);
        let initial = critical_orbit_value(c, 6);
        let root = newton_periodic_point64(c, initial, 6).unwrap();
        assert!(prove_attracting_cycle64(c, 1e-14, root, 6));
        assert!(!prove_attracting_cycle64(c, 1e-3, root, 6));
    }

    #[test]
    fn clamped_deep_pixel_span_encloses_the_full_f64_delta() {
        let pixel_span = 1e-303;
        let screen_dx = 100.0;
        let delta = screen_dx * pixel_span;
        let (_, radius) = render_parameter_ball64(
            screen_dx,
            0.0,
            delta,
            0.0,
            pixel_span,
            &[0.0, 0.0],
            &[0.0, 0.0],
        )
        .unwrap();
        assert!(radius >= delta.abs());
    }

    #[test]
    fn continuous_iteration_matches_the_p04_bailout_formula() {
        let (at_bailout, fraction) = render_continuous_iteration64(23, 1000.0);
        assert!((at_bailout - 23.0).abs() < 1e-12);
        assert!(fraction.abs() < 1e-12);

        let (one_octave, fraction) = render_continuous_iteration64(23, 1_000_000.0);
        assert!((one_octave - 22.0).abs() < 1e-12);
        assert!(fraction.abs() < 1e-12);

        let radius = 1000.0f64.powf(1.5);
        let (smooth, normalized_fraction) = render_continuous_iteration64(23, radius);
        assert!((smooth - (23.0 - 1.5f64.log2())).abs() < 1e-12);
        assert!(normalized_fraction > -1.0 && normalized_fraction <= 0.0);
    }

    #[test]
    fn classic_palette_hits_anchors_and_mirrors_continuously() {
        const X: [f64; 6] = [0.0, 0.16, 0.42, 0.6425, 0.8575, 1.0];
        const RGB: [[f64; 3]; 6] = [
            [0.0, 7.0 / 255.0, 100.0 / 255.0],
            [32.0 / 255.0, 107.0 / 255.0, 203.0 / 255.0],
            [237.0 / 255.0, 1.0, 1.0],
            [1.0, 170.0 / 255.0, 0.0],
            [0.0, 2.0 / 255.0, 0.0],
            [0.0, 7.0 / 255.0, 100.0 / 255.0],
        ];
        for anchor in 0..X.len() {
            for channel in 0..3 {
                assert!(
                    (render_classic_pchip_channel(X[anchor], channel) - RGB[anchor][channel]).abs()
                        < 1e-12
                );
            }
        }

        let palette = create_render_palette();
        for index in [0usize, 97, 511, 863, 1024] {
            let mirror = (RENDER_PALETTE_SIZE - index) % RENDER_PALETTE_SIZE;
            assert_eq!(
                &palette[index * 3..index * 3 + 3],
                &palette[mirror * 3..mirror * 3 + 3]
            );
        }
    }

    #[test]
    fn fieldline_catmull_rom_matches_reference_value() {
        let mut history = OrbitHistory64::new();
        for index in 0..RENDER_FIELDLINE_HISTORY {
            let angle = 0.2 * index as f64;
            history.push(OrbitSample64 {
                iter: index as u32,
                z: Complex64 {
                    re: angle.cos(),
                    im: angle.sin(),
                },
                derivative: ScaledDerivative64::from_complex(Complex64 { re: 1.0, im: 0.0 }),
            });
        }
        let value = render_fieldline64(&history, 0.3, 1e-12).unwrap();
        assert!((value - 0.784_884_924_620_446_8).abs() < 1e-11);
        assert!((-1.0..=1.0).contains(&value));
    }

    fn reference_bandlimited_orbit_sine64(sample: OrbitSample64, pixel_span: f64) -> Option<f64> {
        let z_abs = sample.z.re.hypot(sample.z.im);
        let derivative_abs = sample.derivative.value.re.hypot(sample.derivative.value.im);
        if !sample.derivative.valid
            || !z_abs.is_finite()
            || z_abs <= 0.0
            || !derivative_abs.is_finite()
            || derivative_abs <= 0.0
        {
            return None;
        }
        let direct_gradient = derivative_abs * pixel_span / z_abs;
        let gradient = if sample.derivative.log_scale == 0.0 && direct_gradient.is_finite() {
            direct_gradient.min(1e6)
        } else {
            (derivative_abs.ln() + sample.derivative.log_scale + pixel_span.ln() - z_abs.ln())
                .min(13.815_510_557_964_274)
                .exp()
        };
        let direction_denominator = derivative_abs * z_abs;
        let direction_sin = (sample.derivative.value.im * sample.z.re
            - sample.derivative.value.re * sample.z.im)
            / direction_denominator;
        let direction_cos = (sample.derivative.value.re * sample.z.re
            + sample.derivative.value.im * sample.z.im)
            / direction_denominator;
        Some(
            (sample.z.im / z_abs)
                * render_pixel_sinc64(gradient * direction_sin)
                * render_pixel_sinc64(gradient * direction_cos),
        )
    }

    #[test]
    fn optimized_fieldline_sample_matches_reference_formula() {
        let cases = [
            (
                OrbitSample64 {
                    iter: 1,
                    z: Complex64 { re: 12.0, im: -7.0 },
                    derivative: ScaledDerivative64::from_complex(Complex64 { re: 31.0, im: 17.0 }),
                },
                1e-3,
            ),
            (
                OrbitSample64 {
                    iter: 2,
                    z: Complex64 {
                        re: -820.0,
                        im: 125.0,
                    },
                    derivative: ScaledDerivative64 {
                        value: Complex64 {
                            re: 1e80,
                            im: -3e79,
                        },
                        log_scale: RENDER_DERIVATIVE_LOG_RESCALE,
                        valid: true,
                    },
                },
                1e-100,
            ),
        ];
        for (sample, pixel_span) in cases {
            let expected = reference_bandlimited_orbit_sine64(sample, pixel_span).unwrap();
            let actual =
                render_bandlimited_orbit_sine64(sample, pixel_span, pixel_span.ln()).unwrap();
            assert!((actual - expected).abs() <= 1e-12 * expected.abs().max(1.0));
        }
    }

    #[test]
    fn series_history_is_evaluated_only_when_an_escape_needs_it() {
        let orbit_re = vec![0.0; 129];
        let orbit_im = vec![0.0; 129];
        let c = Complex64 {
            re: 1e-6,
            im: -2e-7,
        };
        let plan = build_series_plan64(&orbit_re, &orbit_im, 12, 128, 2e-6, 1e-10, &[c]);
        assert!(plan.skip >= RENDER_FIELDLINE_HISTORY);
        let mut scalar_history = OrbitHistory64::new();
        scalar_history.push(OrbitSample64 {
            iter: plan.skip as u32,
            z: evaluate_series64(&plan, c.re, c.im),
            derivative: ScaledDerivative64::from_complex(evaluate_series_derivative64(
                &plan, c.re, c.im,
            )),
        });
        let history =
            complete_series_history64(scalar_history, &plan, c.re, c.im, &orbit_re, &orbit_im);
        assert_eq!(history.len, RENDER_FIELDLINE_HISTORY);
        assert_eq!(
            history.get(RENDER_FIELDLINE_HISTORY - 1).unwrap().iter,
            plan.skip as u32
        );
    }

    #[test]
    fn strict_parameter_blocks_certify_only_enclosed_components() {
        for (screen_x, screen_y) in [(1216.5, 448.5), (704.5, 448.5)] {
            let c = periodic_target_parameter(screen_x, screen_y);
            assert!(certify_parameter_block64(c, 1e-15, 1e-14, 5000));
            assert!(!certify_parameter_block64(c, 1e-15, 1e-3, 5000));
        }
        assert!(!certify_parameter_block64(
            periodic_target_parameter(956.0, 474.0),
            1e-15,
            1e-14,
            5000,
        ));
    }

    #[test]
    fn series_tail_and_derivative_match_direct_recurrence() {
        let orbit_re = vec![0.0; 129];
        let orbit_im = vec![0.0; 129];
        let c = Complex64 {
            re: 1e-6,
            im: -2e-7,
        };
        let plan = build_series_plan64(&orbit_re, &orbit_im, 12, 128, 2e-6, 1e-10, &[c]);
        assert!(plan.skip > 0);
        assert!(plan.tail.len() <= RENDER_FIELDLINE_HISTORY);
        assert_eq!(plan.tail.last().unwrap().iter, plan.skip);

        let mut z = Complex64 { re: 0.0, im: 0.0 };
        let mut derivative = Complex64 { re: 0.0, im: 0.0 };
        for _ in 0..plan.skip {
            derivative = complex_add64(
                complex_scale64(complex_mul64(z, derivative), 2.0),
                Complex64 { re: 1.0, im: 0.0 },
            );
            z = complex_add64(complex_square64(z), c);
        }
        let series_z = evaluate_series64(&plan, c.re, c.im);
        let series_derivative = evaluate_series_derivative64(&plan, c.re, c.im);
        assert!(complex_abs_upper64(complex_sub64(series_z, z)) < 1e-15);
        let derivative_error = complex_abs_upper64(complex_sub64(series_derivative, derivative));
        assert!(
            derivative_error < 1e-8,
            "derivative error: {derivative_error:e}"
        );
    }

    #[test]
    fn scaled_derivative_and_de_stay_finite_at_deep_scale() {
        let mut derivative = ScaledDerivative64::from_complex(Complex64 {
            re: 1e119,
            im: -1e119,
        });
        let z = Complex64 { re: 1e20, im: 2e20 };
        for _ in 0..16 {
            derivative.step(z);
        }
        assert!(derivative.valid);
        assert!(derivative.log_abs().unwrap().is_finite());
        let distance = render_distance_pixels64(
            Complex64 {
                re: 1000.0,
                im: 250.0,
            },
            derivative,
            1e-100,
        )
        .unwrap();
        assert!(distance.is_finite() && distance >= 0.0);
    }

    #[test]
    fn sinc_filter_has_the_correct_limit_and_cutoff() {
        assert_eq!(render_pixel_sinc64(0.0), 1.0);
        assert!((render_pixel_sinc64(1e-8) - 1.0).abs() < 1e-12);
        assert!(render_pixel_sinc64(std::f64::consts::PI).abs() < 1.0);
        assert_eq!(render_pixel_sinc64(std::f64::consts::TAU), 0.0);
        assert_eq!(render_pixel_sinc64(f64::INFINITY), 0.0);
    }

    #[test]
    fn invalid_fieldline_falls_back_to_log_continuous_iteration() {
        let result = finish_escaped_pixel64(
            7,
            Complex64 {
                re: 1000.0,
                im: 0.0,
            },
            ScaledDerivative64::from_complex(Complex64 { re: 1.0, im: 0.0 }),
            Complex64 { re: 0.0, im: 0.0 },
            1e-6,
            OrbitHistory64::new(),
            0,
        );
        assert!((result.phase - 7.0f64.ln()).abs() < 1e-12);
    }

    #[test]
    fn rotated_boundary_grid_is_subpixel_and_centered() {
        let (sum_x, sum_y) = RENDER_BOUNDARY_SAMPLE_OFFSETS
            .iter()
            .fold((0.0, 0.0), |(x, y), (dx, dy)| (x + dx, y + dy));
        assert!(sum_x.abs() < 1e-12 && sum_y.abs() < 1e-12);
        for (dx, dy) in RENDER_BOUNDARY_SAMPLE_OFFSETS {
            assert!(dx.abs() < 0.5 && dy.abs() < 0.5);
        }
        assert!(RENDER_BOUNDARY_DISTANCE_PIXELS < 1.0);
    }

    #[test]
    fn interior_rgba_and_repeated_escape_are_deterministic() {
        let mut pixel = [0u8; 4];
        write_render_interior_color(&mut pixel, 0);
        assert_eq!(pixel, [4, 8, 16, 255]);

        let orbit_re = vec![0.0; 65];
        let orbit_im = vec![0.0; 65];
        let first = perturb64(0.5, 0.1, &orbit_re, &orbit_im, 64, 64, 1e-3, &no_series());
        let second = perturb64(0.5, 0.1, &orbit_re, &orbit_im, 64, 64, 1e-3, &no_series());
        assert_eq!(first.iter, second.iter);
        assert_eq!(first.rebase_count, second.rebase_count);
        assert_eq!(first.phase.to_bits(), second.phase.to_bits());
    }
}
