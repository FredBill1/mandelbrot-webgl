use astro_float::{BigFloat, RoundingMode, Sign};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

const RM: RoundingMode = RoundingMode::ToEven;
const BASE_VIEW_WIDTH: f64 = 3.5;

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

#[derive(Serialize)]
struct ReferenceOutput {
    center_re: String,
    center_im: String,
    precision_bits: u32,
    escaped_at: u32,
    orbit_re: Vec<f64>,
    orbit_im: Vec<f64>,
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
            if normalized.cmp(&candidate_bf).is_some_and(|order| order >= 0) {
                digit = candidate;
                break;
            }
        }
        emitted_digits.push(digit);
        normalized = normalized.sub(&BigFloat::from_word(digit as u64, p), p, RM).mul(&ten, p, RM);
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
        return if value.is_negative() { f64::NEG_INFINITY } else { f64::INFINITY };
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
        return if sign == Sign::Neg { f64::NEG_INFINITY } else { f64::INFINITY };
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
        value = value.mul(&ten, p, RM).add(&BigFloat::from_word(digit, p), p, RM);
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
    let bits = estimate_precision_bits(&next_scale_f64.to_string(), 2048).max(estimate_precision_bits(&view.scale, 2048));

    let re = parse_float(&view.re, bits)?;
    let im = parse_float(&view.im, bits)?;
    let scale = parse_float(&view.scale, bits)?;
    let zoom = bf_from_f64(zoom_factor.max(1e-300), bits);
    let next_scale = scale.mul(&zoom, precision(bits), RM);

    let base_span = bf_from_f64(BASE_VIEW_WIDTH, bits);
    let old_pixel_span = base_span.div(&scale, precision(bits), RM).div(&bf_from_f64(view.width.max(1.0), bits), precision(bits), RM);
    let new_pixel_span = base_span.div(&next_scale, precision(bits), RM).div(&bf_from_f64(view.width.max(1.0), bits), precision(bits), RM);

    let ax = anchor_x - view.width * 0.5;
    let ay = anchor_y - view.height * 0.5;
    let old_anchor_re = re.add(&old_pixel_span.mul(&bf_from_f64(ax, bits), precision(bits), RM), precision(bits), RM);
    let old_anchor_im = im.add(&old_pixel_span.mul(&bf_from_f64(ay, bits), precision(bits), RM), precision(bits), RM);

    let after_zoom_re = old_anchor_re.sub(&new_pixel_span.mul(&bf_from_f64(ax, bits), precision(bits), RM), precision(bits), RM);
    let after_zoom_im = old_anchor_im.sub(&new_pixel_span.mul(&bf_from_f64(ay, bits), precision(bits), RM), precision(bits), RM);

    let next_re = after_zoom_re.sub(&new_pixel_span.mul(&bf_from_f64(pan_x, bits), precision(bits), RM), precision(bits), RM);
    let next_im = after_zoom_im.sub(&new_pixel_span.mul(&bf_from_f64(pan_y, bits), precision(bits), RM), precision(bits), RM);
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
    let mut zr = BigFloat::from_word(0, p);
    let mut zi = BigFloat::from_word(0, p);
    let four = BigFloat::from_word(4, p);

    let mut orbit_re = Vec::with_capacity(max_iter as usize + 1);
    let mut orbit_im = Vec::with_capacity(max_iter as usize + 1);
    orbit_re.push(0.0);
    orbit_im.push(0.0);

    let mut escaped_at = max_iter;
    for i in 0..max_iter {
        let zr2 = zr.mul(&zr, p, RM);
        let zi2 = zi.mul(&zi, p, RM);

        if i > 0 {
            let mag2 = zr2.add(&zi2, p, RM);
            if mag2.cmp(&four).is_some_and(|v| v > 0) {
                escaped_at = i;
                break;
            }
        }

        let zrzi = zr.mul(&zi, p, RM);
        let next_re = zr2.sub(&zi2, p, RM).add(&cr, p, RM);
        let next_im = zrzi.add(&zrzi, p, RM).add(&ci, p, RM);

        zr = next_re;
        zi = next_im;

        orbit_re.push(bf_to_f64(&zr));
        orbit_im.push(bf_to_f64(&zi));
    }

    serde_wasm_bindgen::to_value(&ReferenceOutput {
        center_re: center_re.to_string(),
        center_im: center_im.to_string(),
        precision_bits: bits,
        escaped_at,
        orbit_re,
        orbit_im,
    })
    .map_err(|err| JsValue::from_str(&err.to_string()))
}

#[wasm_bindgen]
pub fn direct_escape(re: &str, im: &str, max_iter: u32, precision_bits: u32) -> Result<u32, JsValue> {
    let bits = precision_bits.max(128);
    let p = precision(bits);
    let cr = parse_float(re, bits)?;
    let ci = parse_float(im, bits)?;
    let mut zr = BigFloat::from_word(0, p);
    let mut zi = BigFloat::from_word(0, p);
    let four = BigFloat::from_word(4, p);

    for i in 0..max_iter {
        let zr2 = zr.mul(&zr, p, RM);
        let zi2 = zi.mul(&zi, p, RM);
        let mag2 = zr2.add(&zi2, p, RM);
        if mag2.cmp(&four).is_some_and(|v| v > 0) {
            return Ok(i);
        }
        // z_{i+1} = z_i^2 + c
        let zrzi = zr.mul(&zi, p, RM);
        let next_re = zr2.sub(&zi2, p, RM).add(&cr, p, RM);
        let next_im = zrzi.add(&zrzi, p, RM).add(&ci, p, RM);
        zr = next_re;
        zi = next_im;
    }
    Ok(max_iter)
}
