use astro_float::{BigFloat, RoundingMode, Sign};
use js_sys::{Float64Array, Object, Reflect};
use serde::{Deserialize, Serialize};
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
