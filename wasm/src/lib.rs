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

#[derive(Clone)]
struct CachedRenderReference {
    screen_x: f64,
    screen_y: f64,
    orbit_re: Rc<Vec<f64>>,
    orbit_im: Rc<Vec<f64>>,
    interior_radius: f64,
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
    rebase_count: u32,
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
const RENDER_MAX_SERIES_TILE_RADIUS: f64 = 1e-3;
const RENDER_SERIES_ERROR_SCALE: f64 = 2.9e-2;
const RENDER_SERIES_SKIP_SATURATION: f64 = 0.7;
const RENDER_SERIES_PIXEL_ERROR_SCALE: f64 = 0.25;
const RENDER_INTERIOR_R: u8 = 4;
const RENDER_INTERIOR_G: u8 = 8;
const RENDER_INTERIOR_B: u8 = 16;
const RENDER_PALETTE_SIZE: usize = 2048;
const RENDER_PALETTE_CYCLE_SCALE: f64 = 0.018;
const RENDER_PALETTE_FILTER_LOW: f64 = 0.25;
const RENDER_PALETTE_FILTER_HIGH: f64 = 0.5;
const RENDER_PALETTE_PROXY_FILTER_LOW: f64 = 0.5;
const RENDER_PALETTE_PROXY_FILTER_HIGH: f64 = 1.0;
const RENDER_PALETTE_PROXY_TARGET_FOOTPRINT: f64 = 0.25;
const RENDER_PALETTE_PROXY_STRENGTH: f64 = 0.25;
const RENDER_PALETTE_PROXY_FADE_LOW: f64 = 32.0;
const RENDER_PALETTE_PROXY_FADE_HIGH: f64 = 64.0;
const RENDER_INV_LN2: f64 = std::f64::consts::LOG2_E;
const RENDER_SMOOTH_LOG_SCALE: f64 = 0.5 * std::f64::consts::LOG2_E;
const RENDER_REFERENCE_INTERIOR_RADIUS_SAFETY: f64 = 0.90;
const RENDER_REFERENCE_INTERIOR_MIN_BLOCK_SIZE: usize = 16;

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
    let reference = CachedRenderReference {
        screen_x,
        screen_y,
        orbit_re: Rc::new(orbit_re),
        orbit_im: Rc::new(orbit_im),
        interior_radius: max_iter_bounded_radius,
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
    let mut context = build_render_context(rect, pixel_span)?;
    ensure_render_series(&mut context, 16, pixel_span);
    let series_skip = context
        .series
        .as_ref()
        .map_or(0, |series| series.skip as u32);
    let palette = RENDER_PALETTE_CACHE.with(Rc::clone);
    let mut rgba = vec![0u8; width * height * 4];
    let mut certified_interior_mask = vec![0u8; width * height];
    let mut escaped_pixels = 0u32;
    let periodic_interior_count = certify_render_blocks64(
        &mut certified_interior_mask,
        &mut rgba,
        width,
        height,
        rect,
        pixel_span,
        max_iter,
        &context,
        palette.colors.as_slice(),
    );
    let mut cap_hit_unknown_count = 0u32;
    let mut rebase_count = 0u32;
    let mut escaped_mask = vec![0u8; width * height];
    let mut smooth_values = vec![0f32; width * height];
    let mut palette_footprints = vec![-1f32; width * height];
    let screen_xs: Vec<f64> = (0..width).map(|px| rect.x + px as f64 + 0.5).collect();
    let screen_ys: Vec<f64> = (0..height).map(|py| rect.y + py as f64 + 0.5).collect();
    for py in 0..height {
        let screen_y = screen_ys[py];
        for px in 0..width {
            let pixel_index = py * width + px;
            if certified_interior_mask[pixel_index] != 0 {
                continue;
            }
            let screen_x = screen_xs[px];
            let result = render_pixel64(screen_x, screen_y, pixel_span, max_iter, &context);
            let offset = pixel_index * 4;
            if result.iter < max_iter {
                escaped_pixels += 1;
                escaped_mask[pixel_index] = 1;
            } else {
                cap_hit_unknown_count += 1;
            }
            rebase_count += result.rebase_count;
            let smooth = render_smooth_iteration(result.iter, max_iter, result.mag2);
            smooth_values[pixel_index] = smooth as f32;
            write_render_color_for_smooth(
                &mut rgba,
                offset,
                result.iter >= max_iter,
                smooth,
                palette.colors.as_slice(),
            );
        }
    }

    let palette_footprint_fallback_count = estimate_render_palette_footprints_from_smooth(
        &mut palette_footprints,
        &smooth_values,
        &escaped_mask,
        width,
        height,
    );
    let mut palette_filter_stats = apply_render_bandlimited_palette_shading(
        &mut rgba,
        &smooth_values,
        &palette_footprints,
        &escaped_mask,
        width,
        height,
        palette.as_ref(),
    );
    palette_filter_stats.palette_footprint_fallback_count = palette_footprint_fallback_count;
    let elapsed_ms = js_sys::Date::now() - started;
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
        series_skip,
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
    certify_render_block64(
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
) {
    if block_width == 0 || block_height == 0 {
        return;
    }

    if certifies_render_block64(context, rect, pixel_span, x0, y0, block_width, block_height) {
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
            y0,
            left_width,
            block_height,
            certified,
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
        );
    } else if block_height > RENDER_REFERENCE_INTERIOR_MIN_BLOCK_SIZE {
        let top_height = block_height / 2;
        let bottom_height = block_height - top_height;
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
            y0,
            block_width,
            top_height,
            certified,
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
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn certifies_render_block64(
    context: &RenderContext,
    rect: Rect64,
    pixel_span: f64,
    x0: usize,
    y0: usize,
    block_width: usize,
    block_height: usize,
) -> bool {
    let screen_x = rect.x + x0 as f64 + block_width as f64 * 0.5;
    let screen_y = rect.y + y0 as f64 + block_height as f64 * 0.5;
    let block_radius = (block_width as f64).hypot(block_height as f64) * 0.5 * pixel_span;
    if !screen_x.is_finite() || !screen_y.is_finite() || !block_radius.is_finite() {
        return false;
    }
    let reference = &context.reference;
    let center_delta =
        (screen_x - reference.screen_x).hypot(screen_y - reference.screen_y) * pixel_span;
    let covered_radius = reference.interior_radius * RENDER_REFERENCE_INTERIOR_RADIUS_SAFETY;
    covered_radius > 0.0 && center_delta + block_radius <= covered_radius
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
    max_iter: u32,
    palette: &[u8],
) {
    let smooth = max_iter as f64;
    for y in y0..(y0 + block_height) {
        for x in x0..(x0 + block_width) {
            let index = y * stride + x;
            mask[index] = 1;
            write_render_color_for_smooth(rgba, index * 4, true, smooth, palette);
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
    series_skip: u32,
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
    set_js_property(&stats, "seriesSkip", &JsValue::from_f64(series_skip as f64))?;
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
    context: &RenderContext,
) -> PixelResult64 {
    let c_re = (screen_x - context.reference.screen_x) * pixel_span;
    let c_im = (screen_y - context.reference.screen_y) * pixel_span;
    perturb64(
        c_re,
        c_im,
        &context.reference.orbit_re,
        &context.reference.orbit_im,
        max_iter,
        context.series.as_ref().expect("series plan is initialized"),
    )
}

fn ensure_render_series(context: &mut RenderContext, series_degree: usize, pixel_span: f64) {
    if context.series.is_none() {
        context.series = Some(build_series_plan64(
            &context.reference.orbit_re,
            &context.reference.orbit_im,
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
    max_iter: u32,
    series: &SeriesPlan64,
) -> PixelResult64 {
    let mut dz_re = 0.0;
    let mut dz_im = 0.0;
    let mut iter = 0u32;
    let mut ref_index = 0usize;
    let mut mag2 = 0.0;
    let mut rebase_count = 0u32;

    if series.skip > 0 {
        let dz = evaluate_series64(series, c_re, c_im);
        dz_re = dz.re;
        dz_im = dz.im;
        iter = series.skip as u32;
        ref_index = series.skip;
    }

    let limit = max_iter.min((orbit_re.len().saturating_sub(1)) as u32) as usize;
    debug_assert!(ref_index <= limit);

    while iter <= max_iter && ref_index <= limit {
        let ref_re = orbit_re[ref_index];
        let ref_im = orbit_im[ref_index];
        if !ref_re.is_finite() || !ref_im.is_finite() {
            return PixelResult64 {
                iter,
                mag2: f64::INFINITY,
                rebase_count,
            };
        }

        let z_re = ref_re + dz_re;
        let z_im = ref_im + dz_im;
        if !z_re.is_finite() || !z_im.is_finite() {
            return PixelResult64 {
                iter,
                mag2: f64::INFINITY,
                rebase_count,
            };
        }
        let z_norm = z_re.abs().max(z_im.abs());
        if z_norm > 2.0 {
            mag2 = z_re * z_re + z_im * z_im;
            return PixelResult64 {
                iter,
                mag2,
                rebase_count,
            };
        }
        if iter >= max_iter {
            return PixelResult64 {
                iter: max_iter,
                mag2,
                rebase_count,
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

        let dz2_re = dz_re * dz_re - dz_im * dz_im;
        let dz2_im = 2.0 * dz_re * dz_im;
        let two_ref_dz_re = 2.0 * (step_ref_re * dz_re - step_ref_im * dz_im);
        let two_ref_dz_im = 2.0 * (step_ref_re * dz_im + step_ref_im * dz_re);
        dz_re = two_ref_dz_re + dz2_re + c_re;
        dz_im = two_ref_dz_im + dz2_im + c_im;
        iter += 1;
        ref_index += 1;

        if !dz_re.is_finite() || !dz_im.is_finite() {
            return PixelResult64 {
                iter,
                mag2: f64::INFINITY,
                rebase_count,
            };
        }
    }
    PixelResult64 {
        iter: max_iter,
        mag2,
        rebase_count,
    }
}

fn build_series_plan64(
    orbit_re: &[f64],
    orbit_im: &[f64],
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
    normalized_degree: usize,
    max_skip: usize,
    tile_radius: f64,
    pixel_span: f64,
    probes: &[Complex64],
) -> SeriesPlan64 {
    let mut coeff_re = vec![0.0; normalized_degree + 1];
    let mut coeff_im = vec![0.0; normalized_degree + 1];
    if normalized_degree < 2
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
        };
    }

    let mut next_re = vec![0.0; normalized_degree + 1];
    let mut next_im = vec![0.0; normalized_degree + 1];
    let mut probe_re = vec![0.0; probes.len()];
    let mut probe_im = vec![0.0; probes.len()];
    let mut next_probe_re = vec![0.0; probes.len()];
    let mut next_probe_im = vec![0.0; probes.len()];
    let mut skip = 0usize;
    let mut error_bound = 0.0f64;
    let error_limit = pixel_span.abs() * RENDER_SERIES_PIXEL_ERROR_SCALE;

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

        let Some(probe_error) = probes_validate_series_step64(
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
        ) else {
            break;
        };
        let derivative_lower_bound =
            series_derivative_lower_bound64(&next_re, &next_im, tile_radius);
        if derivative_lower_bound <= 0.0 {
            break;
        }
        let orbit_error_bound = next_up_nonnegative(probe_error);
        let next_error_bound =
            next_up_nonnegative(error_bound.max(orbit_error_bound / derivative_lower_bound));
        if !next_error_bound.is_finite() || next_error_bound > error_limit {
            break;
        }
        coeff_re.copy_from_slice(&next_re);
        coeff_im.copy_from_slice(&next_im);
        probe_re.copy_from_slice(&next_probe_re);
        probe_im.copy_from_slice(&next_probe_im);
        error_bound = next_error_bound;
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
                (RENDER_PALETTE_CYCLE_SCALE * gradient) as f32
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
    let mut palette_proxy_count = 0u32;
    let mut max_palette_footprint = 0.0f64;
    let mut max_palette_proxy_lod = 0.0f64;
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
        let mut color = blend_render_linear_color(
            LinearColor64 {
                r: palette.srgb_to_linear[buffer[offset] as usize],
                g: palette.srgb_to_linear[buffer[offset + 1] as usize],
                b: palette.srgb_to_linear[buffer[offset + 2] as usize],
            },
            integrated_render_palette_linear_color(smooth_values[index] as f64, footprint, palette),
            filter_amount,
        );
        palette_filtered_count += 1;

        let proxy_amount = render_palette_proxy_weight(footprint);
        if proxy_amount > 0.0 {
            let (proxy_color, lod) =
                render_palette_proxy_linear_color(smooth_values[index] as f64, footprint, palette);
            color = add_render_palette_proxy_residual(
                color,
                proxy_color,
                proxy_amount * RENDER_PALETTE_PROXY_STRENGTH,
                palette,
            );
            palette_proxy_count += 1;
            max_palette_proxy_lod = max_palette_proxy_lod.max(lod);
        }
        write_render_linear_color(buffer, offset, color);
    }
    PaletteFilterStats64 {
        palette_footprint_count,
        palette_footprint_fallback_count: 0,
        palette_filtered_count,
        palette_proxy_count,
        max_palette_footprint,
        max_palette_proxy_lod,
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

fn write_render_color_for_smooth(
    buffer: &mut [u8],
    offset: usize,
    interior: bool,
    smooth: f64,
    palette: &[u8],
) {
    if interior {
        buffer[offset] = RENDER_INTERIOR_R;
        buffer[offset + 1] = RENDER_INTERIOR_G;
        buffer[offset + 2] = RENDER_INTERIOR_B;
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
    smooth: f64,
    footprint: f64,
    palette: &RenderPaletteCache,
) -> LinearColor64 {
    let width = footprint.max(f64::EPSILON);
    let center = smooth * RENDER_PALETTE_CYCLE_SCALE;
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

fn render_palette_linear_mean(palette: &RenderPaletteCache) -> LinearColor64 {
    let offset = RENDER_PALETTE_SIZE * 3;
    LinearColor64 {
        r: palette.linear_prefix[offset],
        g: palette.linear_prefix[offset + 1],
        b: palette.linear_prefix[offset + 2],
    }
}

fn render_palette_proxy_weight(footprint: f64) -> f64 {
    let activation = smoothstep(
        RENDER_PALETTE_PROXY_FILTER_LOW,
        RENDER_PALETTE_PROXY_FILTER_HIGH,
        footprint,
    );
    let extreme_fade = 1.0
        - smoothstep(
            RENDER_PALETTE_PROXY_FADE_LOW,
            RENDER_PALETTE_PROXY_FADE_HIGH,
            footprint,
        );
    activation * extreme_fade
}

fn render_palette_proxy_linear_color(
    smooth: f64,
    footprint: f64,
    palette: &RenderPaletteCache,
) -> (LinearColor64, f64) {
    let phase = smooth * RENDER_PALETTE_CYCLE_SCALE;
    let lod =
        1.0f64.max((footprint.max(f64::EPSILON) / RENDER_PALETTE_PROXY_TARGET_FOOTPRINT).log2());
    let low_level = lod.floor();
    let level_blend = lod - low_level;
    let low_divisor = 2.0f64.powi(low_level as i32);
    let low_color = render_palette_linear_color_at_phase(phase / low_divisor, palette);
    let high_color = render_palette_linear_color_at_phase(phase / (low_divisor * 2.0), palette);
    (
        blend_render_linear_color(low_color, high_color, level_blend),
        lod,
    )
}

fn render_palette_linear_color_at_phase(phase: f64, palette: &RenderPaletteCache) -> LinearColor64 {
    let fraction = phase - phase.floor();
    let index = ((fraction * RENDER_PALETTE_SIZE as f64).floor().max(0.0) as usize)
        .min(RENDER_PALETTE_SIZE - 1);
    let offset = index * 3;
    LinearColor64 {
        r: palette.linear_colors[offset],
        g: palette.linear_colors[offset + 1],
        b: palette.linear_colors[offset + 2],
    }
}

fn add_render_palette_proxy_residual(
    base: LinearColor64,
    proxy: LinearColor64,
    amount: f64,
    palette: &RenderPaletteCache,
) -> LinearColor64 {
    let mean = render_palette_linear_mean(palette);
    LinearColor64 {
        r: clamp01(base.r + (proxy.r - mean.r) * amount),
        g: clamp01(base.g + (proxy.g - mean.g) * amount),
        b: clamp01(base.b + (proxy.b - mean.b) * amount),
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

fn render_palette_index(smooth: f64) -> usize {
    let value = smooth * RENDER_PALETTE_CYCLE_SCALE;
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
        }
    }

    #[test]
    fn finite_large_delta_is_an_escape_not_a_numeric_failure() {
        let result = perturb64(1e150, 0.0, &[0.0, 0.0], &[0.0, 0.0], 8, &no_series());
        assert!(result.iter < 8);
    }

    #[test]
    fn carries_on_after_a_short_reference_orbit() {
        let result = perturb64(-1.0, 0.0, &[0.0, 1.0], &[0.0, 0.0], 32, &no_series());
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
}
