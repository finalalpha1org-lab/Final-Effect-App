#include "../include/fe_abi.h"
#include "../include/fe_math.hpp"

namespace {

constexpr uint32_t kMaxAnimatedObjects = 96;
constexpr uint32_t kMaxKeysPerChannel  = 128;

struct Keyframe {
  float    frame;
  float    value;
  uint32_t interp;
};

struct ChannelTrack {
  uint32_t count;
  Keyframe keys[kMaxKeysPerChannel];
};

struct ObjectAnimTrack {
  uint8_t      initialized;
  uint32_t     extrapolation;
  float        rest[FE_CH_COUNT];
  ChannelTrack channels[FE_CH_COUNT];
};

static ObjectAnimTrack g_tracks[kMaxAnimatedObjects];

static void default_rest_channels(float out[FE_CH_COUNT]) {
  out[FE_CH_POS_X] = 0.0f;
  out[FE_CH_POS_Y] = 0.0f;
  out[FE_CH_POS_Z] = 0.0f;
  out[FE_CH_ROT_X] = 0.0f;
  out[FE_CH_ROT_Y] = 0.0f;
  out[FE_CH_ROT_Z] = 0.0f;
  out[FE_CH_SCL_X] = 1.0f;
  out[FE_CH_SCL_Y] = 1.0f;
  out[FE_CH_SCL_Z] = 1.0f;
  out[FE_CH_EXTRA_A] = 50.0f;
  out[FE_CH_EXTRA_B] = 0.5f;
}

static float bounce_out(float t) {
  const float n1 = 7.5625f;
  const float d1 = 2.75f;
  if (t < 1.0f / d1) {
    return n1 * t * t;
  } else if (t < 2.0f / d1) {
    t -= 1.5f / d1;
    return n1 * t * t + 0.75f;
  } else if (t < 2.5f / d1) {
    t -= 2.25f / d1;
    return n1 * t * t + 0.9375f;
  } else {
    t -= 2.625f / d1;
    return n1 * t * t + 0.984375f;
  }
}

static float map_extrapolated_frame(float f, float first_f, float last_f, uint32_t extrap) {
  const float span = last_f - first_f;
  if (span <= 1e-5f || extrap == FE_EXTRAP_HOLD) {
    return fe::clampf(f, first_f, last_f);
  }
  const float rel = f - first_f;
  if (extrap == FE_EXTRAP_LOOP) {
    float m = rel - fe::floorf(rel / span) * span;
    return first_f + fe::clampf(m, 0.0f, span);
  }
  if (extrap == FE_EXTRAP_PINGPONG) {
    const float period = 2.0f * span;
    float m = rel - fe::floorf(rel / period) * period;
    if (m > span) m = period - m;
    return first_f + fe::clampf(m, 0.0f, span);
  }
  return fe::clampf(f, first_f, last_f);
}

/* Auto-clamped monotone cubic Hermite (Blender Auto-Clamped Bezier style — smooth with zero overshoot!) */
static float eval_channel_internal(const ChannelTrack& ch, float rest_val, float frame, uint32_t extrap) {
  if (ch.count == 0) return rest_val;
  if (ch.count == 1) return ch.keys[0].value;

  const float first_f = ch.keys[0].frame;
  const float last_f  = ch.keys[ch.count - 1].frame;
  const float qf = map_extrapolated_frame(frame, first_f, last_f, extrap);

  if (qf <= first_f) return ch.keys[0].value;
  if (qf >= last_f)  return ch.keys[ch.count - 1].value;

  /* Binary search segment [lo, lo+1] */
  uint32_t lo = 0;
  uint32_t hi = ch.count - 1;
  while (lo + 1 < hi) {
    const uint32_t mid = (lo + hi) >> 1u;
    if (ch.keys[mid].frame <= qf) lo = mid;
    else hi = mid;
  }

  const Keyframe& k0 = ch.keys[lo];
  const Keyframe& k1 = ch.keys[lo + 1];
  const float dt = k1.frame - k0.frame;
  if (dt <= 1e-6f) return k1.value;
  const float u = fe::clampf((qf - k0.frame) / dt, 0.0f, 1.0f);

  switch (k0.interp) {
    case FE_INTERP_STEP:
      return k0.value;
    case FE_INTERP_LINEAR:
      return fe::lerpf(k0.value, k1.value, u);
    case FE_INTERP_EASE_IN:
      return fe::lerpf(k0.value, k1.value, u * u * u);
    case FE_INTERP_EASE_OUT: {
      const float inv = 1.0f - u;
      return fe::lerpf(k0.value, k1.value, 1.0f - inv * inv * inv);
    }
    case FE_INTERP_BOUNCE:
      return fe::lerpf(k0.value, k1.value, bounce_out(u));
    case FE_INTERP_BEZIER_SMOOTH:
    default: {
      const float sec = (k1.value - k0.value) / dt;
      float m0 = sec;
      float m1 = sec;
      if (lo > 0) {
        const float dt_prev = k0.frame - ch.keys[lo - 1].frame;
        if (dt_prev > 1e-6f) {
          const float sec_prev = (k0.value - ch.keys[lo - 1].value) / dt_prev;
          m0 = (sec_prev * sec <= 0.0f) ? 0.0f : 0.5f * (sec_prev + sec);
        }
      }
      if (lo + 2 < ch.count) {
        const float dt_next = ch.keys[lo + 2].frame - k1.frame;
        if (dt_next > 1e-6f) {
          const float sec_next = (ch.keys[lo + 2].value - k1.value) / dt_next;
          m1 = (sec * sec_next <= 0.0f) ? 0.0f : 0.5f * (sec + sec_next);
        }
      }
      /* Monotonicity clamp (Fritsch-Carlson) */
      if (fe::absf(sec) < 1e-7f) {
        m0 = 0.0f;
        m1 = 0.0f;
      } else {
        const float a = m0 / sec;
        const float b = m1 / sec;
        const float h = a * a + b * b;
        if (h > 9.0f) {
          const float tau = 3.0f / fe::sqrtf(h);
          m0 = tau * a * sec;
          m1 = tau * b * sec;
        }
      }
      const float u2 = u * u;
      const float u3 = u2 * u;
      const float h00 =  2.0f * u3 - 3.0f * u2 + 1.0f;
      const float h10 =         u3 - 2.0f * u2 + u;
      const float h01 = -2.0f * u3 + 3.0f * u2;
      const float h11 =         u3 -        u2;
      return h00 * k0.value + h10 * dt * m0 + h01 * k1.value + h11 * dt * m1;
    }
  }
}

} // namespace

extern "C" {

FE_EXPORT void fe_anim_reset(void) {
  for (uint32_t s = 0; s < kMaxAnimatedObjects; ++s) {
    g_tracks[s].initialized = 0;
    g_tracks[s].extrapolation = FE_EXTRAP_HOLD;
    default_rest_channels(g_tracks[s].rest);
    for (uint32_t c = 0; c < FE_CH_COUNT; ++c) {
      g_tracks[s].channels[c].count = 0;
    }
  }
}

FE_EXPORT int32_t fe_anim_ensure_object(uint32_t object_slot, const float* rest_channels_11) {
  if (object_slot >= kMaxAnimatedObjects) return -1;
  ObjectAnimTrack& tr = g_tracks[object_slot];
  if (!tr.initialized) {
    tr.initialized = 1;
    tr.extrapolation = FE_EXTRAP_HOLD;
    default_rest_channels(tr.rest);
    for (uint32_t c = 0; c < FE_CH_COUNT; ++c) tr.channels[c].count = 0;
  }
  if (rest_channels_11) {
    for (uint32_t c = 0; c < FE_CH_COUNT; ++c) {
      if (fe::isfinitef(rest_channels_11[c])) {
        tr.rest[c] = rest_channels_11[c];
      }
    }
  }
  return 1;
}

FE_EXPORT int32_t fe_anim_set_extrapolation(uint32_t object_slot, uint32_t extrap_mode) {
  if (object_slot >= kMaxAnimatedObjects) return -1;
  if (!g_tracks[object_slot].initialized) fe_anim_ensure_object(object_slot, nullptr);
  g_tracks[object_slot].extrapolation = extrap_mode <= FE_EXTRAP_PINGPONG ? extrap_mode : static_cast<uint32_t>(FE_EXTRAP_HOLD);
  return 1;
}

FE_EXPORT uint32_t fe_anim_get_extrapolation(uint32_t object_slot) {
  if (object_slot >= kMaxAnimatedObjects || !g_tracks[object_slot].initialized) return FE_EXTRAP_HOLD;
  return g_tracks[object_slot].extrapolation;
}

FE_EXPORT int32_t fe_anim_insert_keyframe(
  uint32_t object_slot,
  uint32_t channel,
  float frame,
  float value,
  uint32_t interp_mode
) {
  if (object_slot >= kMaxAnimatedObjects || channel >= FE_CH_COUNT) return -1;
  if (!fe::isfinitef(frame) || !fe::isfinitef(value)) return -2;
  if (!g_tracks[object_slot].initialized) fe_anim_ensure_object(object_slot, nullptr);

  /* Enforce positive minimum scale on scale channels */
  if (channel >= FE_CH_SCL_X && channel <= FE_CH_SCL_Z) {
    value = fe::maxf(0.01f, value);
  }

  ChannelTrack& ch = g_tracks[object_slot].channels[channel];
  const uint32_t mode = interp_mode <= FE_INTERP_BOUNCE ? interp_mode : static_cast<uint32_t>(FE_INTERP_BEZIER_SMOOTH);

  /* Replace existing keyframe if within 0.01 frames */
  for (uint32_t i = 0; i < ch.count; ++i) {
    if (fe::absf(ch.keys[i].frame - frame) <= 0.01f) {
      ch.keys[i].frame  = frame;
      ch.keys[i].value  = value;
      ch.keys[i].interp = mode;
      return static_cast<int32_t>(i);
    }
  }

  if (ch.count >= kMaxKeysPerChannel) return -3;

  uint32_t insert_idx = ch.count;
  while (insert_idx > 0 && ch.keys[insert_idx - 1].frame > frame) {
    ch.keys[insert_idx] = ch.keys[insert_idx - 1];
    --insert_idx;
  }
  ch.keys[insert_idx].frame  = frame;
  ch.keys[insert_idx].value  = value;
  ch.keys[insert_idx].interp = mode;
  ++ch.count;
  return static_cast<int32_t>(insert_idx);
}

FE_EXPORT int32_t fe_anim_remove_keyframe_at(
  uint32_t object_slot,
  uint32_t channel,
  float frame,
  float tolerance
) {
  if (object_slot >= kMaxAnimatedObjects) return -1;
  const float tol = tolerance > 0.0f ? tolerance : 0.45f;

  auto remove_in_channel = [&](ChannelTrack& ch) -> uint32_t {
    uint32_t write_i = 0;
    uint32_t removed = 0;
    for (uint32_t i = 0; i < ch.count; ++i) {
      if (fe::absf(ch.keys[i].frame - frame) <= tol) {
        ++removed;
      } else {
        ch.keys[write_i++] = ch.keys[i];
      }
    }
    ch.count = write_i;
    return removed;
  };

  if (channel == 0xFFFFFFFFu) {
    uint32_t total = 0;
    for (uint32_t c = 0; c < FE_CH_COUNT; ++c) {
      total += remove_in_channel(g_tracks[object_slot].channels[c]);
    }
    return static_cast<int32_t>(total);
  }
  if (channel >= FE_CH_COUNT) return -1;
  return static_cast<int32_t>(remove_in_channel(g_tracks[object_slot].channels[channel]));
}

FE_EXPORT void fe_anim_clear_object(uint32_t object_slot) {
  if (object_slot >= kMaxAnimatedObjects) return;
  for (uint32_t c = 0; c < FE_CH_COUNT; ++c) {
    g_tracks[object_slot].channels[c].count = 0;
  }
}

FE_EXPORT uint32_t fe_anim_get_keyframe_count(uint32_t object_slot, uint32_t channel) {
  if (object_slot >= kMaxAnimatedObjects || !g_tracks[object_slot].initialized) return 0;
  if (channel == 0xFFFFFFFFu) {
    uint32_t sum = 0;
    for (uint32_t c = 0; c < FE_CH_COUNT; ++c) sum += g_tracks[object_slot].channels[c].count;
    return sum;
  }
  if (channel >= FE_CH_COUNT) return 0;
  return g_tracks[object_slot].channels[channel].count;
}

FE_EXPORT uint32_t fe_anim_get_total_keyframes(void) {
  uint32_t total = 0;
  for (uint32_t s = 0; s < kMaxAnimatedObjects; ++s) {
    if (!g_tracks[s].initialized) continue;
    for (uint32_t c = 0; c < FE_CH_COUNT; ++c) {
      total += g_tracks[s].channels[c].count;
    }
  }
  return total;
}

FE_EXPORT uint32_t fe_anim_list_object_keyframes(
  uint32_t object_slot,
  uint32_t channel,
  float* out_frames_values_interp,
  uint32_t max_out
) {
  if (object_slot >= kMaxAnimatedObjects || channel >= FE_CH_COUNT || !out_frames_values_interp) return 0;
  if (!g_tracks[object_slot].initialized) return 0;
  const ChannelTrack& ch = g_tracks[object_slot].channels[channel];
  const uint32_t n = ch.count < max_out ? ch.count : max_out;
  for (uint32_t i = 0; i < n; ++i) {
    out_frames_values_interp[i * 3 + 0] = ch.keys[i].frame;
    out_frames_values_interp[i * 3 + 1] = ch.keys[i].value;
    out_frames_values_interp[i * 3 + 2] = static_cast<float>(ch.keys[i].interp);
  }
  return n;
}

FE_EXPORT float fe_anim_evaluate_channel(
  uint32_t object_slot,
  uint32_t channel,
  float frame,
  float /*range_start*/,
  float /*range_end*/
) {
  if (object_slot >= kMaxAnimatedObjects || channel >= FE_CH_COUNT) return 0.0f;
  const ObjectAnimTrack& tr = g_tracks[object_slot];
  if (!tr.initialized) return (channel >= FE_CH_SCL_X && channel <= FE_CH_SCL_Z) ? 1.0f : 0.0f;
  float v = eval_channel_internal(tr.channels[channel], tr.rest[channel], frame, tr.extrapolation);
  if (channel >= FE_CH_SCL_X && channel <= FE_CH_SCL_Z) v = fe::maxf(0.01f, v);
  return v;
}

FE_EXPORT int32_t fe_anim_evaluate_object(
  uint32_t object_slot,
  float frame,
  float /*range_start*/,
  float /*range_end*/,
  float* out_15
) {
  if (object_slot >= kMaxAnimatedObjects || !out_15) return -1;
  const ObjectAnimTrack& tr = g_tracks[object_slot];
  if (!tr.initialized) return 0;

  uint32_t has_any_keys = 0;
  for (uint32_t c = 0; c < FE_CH_COUNT; ++c) {
    if (tr.channels[c].count > 0) has_any_keys = 1;
    float v = eval_channel_internal(tr.channels[c], tr.rest[c], frame, tr.extrapolation);
    if (c >= FE_CH_SCL_X && c <= FE_CH_SCL_Z) v = fe::maxf(0.01f, v);
    out_15[c] = v;
  }

  const fe::Quat q = fe::Quat::from_euler_xyz_deg(
    out_15[FE_CH_ROT_X],
    out_15[FE_CH_ROT_Y],
    out_15[FE_CH_ROT_Z]
  ).normalized();
  out_15[11] = q.x;
  out_15[12] = q.y;
  out_15[13] = q.z;
  out_15[14] = q.w;
  return static_cast<int32_t>(has_any_keys);
}

FE_EXPORT int32_t fe_anim_apply_preset(
  uint32_t object_slot,
  uint32_t preset_id,
  float start_frame,
  float end_frame,
  float amplitude,
  const float* base_channels_11
) {
  if (object_slot >= kMaxAnimatedObjects) return -1;
  if (end_frame <= start_frame + 1.0f) end_frame = start_frame + 120.0f;
  fe_anim_ensure_object(object_slot, base_channels_11);
  fe_anim_clear_object(object_slot);

  const float* base = g_tracks[object_slot].rest;
  const float span = end_frame - start_frame;
  const float amp  = amplitude > 0.01f ? amplitude : 1.0f;
  const float mid  = start_frame + span * 0.5f;
  const float q1   = start_frame + span * 0.25f;
  const float q3   = start_frame + span * 0.75f;

  switch (preset_id) {
    case FE_PRESET_TURNTABLE: {
      fe_anim_set_extrapolation(object_slot, FE_EXTRAP_LOOP);
      fe_anim_insert_keyframe(object_slot, FE_CH_ROT_Y, start_frame, base[FE_CH_ROT_Y], FE_INTERP_LINEAR);
      fe_anim_insert_keyframe(object_slot, FE_CH_ROT_Y, end_frame,   base[FE_CH_ROT_Y] + 360.0f * amp, FE_INTERP_LINEAR);
      break;
    }
    case FE_PRESET_FLOAT_HOVER: {
      fe_anim_set_extrapolation(object_slot, FE_EXTRAP_LOOP);
      const float h = 0.65f * amp;
      fe_anim_insert_keyframe(object_slot, FE_CH_POS_Y, start_frame, base[FE_CH_POS_Y], FE_INTERP_BEZIER_SMOOTH);
      fe_anim_insert_keyframe(object_slot, FE_CH_POS_Y, q1,          base[FE_CH_POS_Y] + h, FE_INTERP_BEZIER_SMOOTH);
      fe_anim_insert_keyframe(object_slot, FE_CH_POS_Y, mid,         base[FE_CH_POS_Y], FE_INTERP_BEZIER_SMOOTH);
      fe_anim_insert_keyframe(object_slot, FE_CH_POS_Y, q3,          base[FE_CH_POS_Y] - h * 0.45f, FE_INTERP_BEZIER_SMOOTH);
      fe_anim_insert_keyframe(object_slot, FE_CH_POS_Y, end_frame,   base[FE_CH_POS_Y], FE_INTERP_BEZIER_SMOOTH);

      fe_anim_insert_keyframe(object_slot, FE_CH_ROT_Z, start_frame, base[FE_CH_ROT_Z] - 6.0f * amp, FE_INTERP_BEZIER_SMOOTH);
      fe_anim_insert_keyframe(object_slot, FE_CH_ROT_Z, mid,         base[FE_CH_ROT_Z] + 6.0f * amp, FE_INTERP_BEZIER_SMOOTH);
      fe_anim_insert_keyframe(object_slot, FE_CH_ROT_Z, end_frame,   base[FE_CH_ROT_Z] - 6.0f * amp, FE_INTERP_BEZIER_SMOOTH);
      break;
    }
    case FE_PRESET_BOUNCE: {
      fe_anim_set_extrapolation(object_slot, FE_EXTRAP_LOOP);
      const float jump = 2.0f * amp;
      const float sx = base[FE_CH_SCL_X], sy = base[FE_CH_SCL_Y], sz = base[FE_CH_SCL_Z];
      fe_anim_insert_keyframe(object_slot, FE_CH_POS_Y, start_frame, base[FE_CH_POS_Y] + jump, FE_INTERP_BOUNCE);
      fe_anim_insert_keyframe(object_slot, FE_CH_POS_Y, mid,         base[FE_CH_POS_Y], FE_INTERP_EASE_OUT);
      fe_anim_insert_keyframe(object_slot, FE_CH_POS_Y, end_frame,   base[FE_CH_POS_Y] + jump, FE_INTERP_BEZIER_SMOOTH);

      /* Subtle squash & stretch */
      fe_anim_insert_keyframe(object_slot, FE_CH_SCL_Y, start_frame, sy * 1.12f, FE_INTERP_BEZIER_SMOOTH);
      fe_anim_insert_keyframe(object_slot, FE_CH_SCL_Y, mid,         fe::maxf(0.05f, sy * 0.82f), FE_INTERP_BEZIER_SMOOTH);
      fe_anim_insert_keyframe(object_slot, FE_CH_SCL_Y, end_frame,   sy * 1.12f, FE_INTERP_BEZIER_SMOOTH);

      fe_anim_insert_keyframe(object_slot, FE_CH_SCL_X, start_frame, sx * 0.94f, FE_INTERP_BEZIER_SMOOTH);
      fe_anim_insert_keyframe(object_slot, FE_CH_SCL_X, mid,         sx * 1.14f, FE_INTERP_BEZIER_SMOOTH);
      fe_anim_insert_keyframe(object_slot, FE_CH_SCL_X, end_frame,   sx * 0.94f, FE_INTERP_BEZIER_SMOOTH);

      fe_anim_insert_keyframe(object_slot, FE_CH_SCL_Z, start_frame, sz * 0.94f, FE_INTERP_BEZIER_SMOOTH);
      fe_anim_insert_keyframe(object_slot, FE_CH_SCL_Z, mid,         sz * 1.14f, FE_INTERP_BEZIER_SMOOTH);
      fe_anim_insert_keyframe(object_slot, FE_CH_SCL_Z, end_frame,   sz * 0.94f, FE_INTERP_BEZIER_SMOOTH);
      break;
    }
    case FE_PRESET_PENDULUM: {
      fe_anim_set_extrapolation(object_slot, FE_EXTRAP_LOOP);
      const float deg = 32.0f * amp;
      const float swing_x = 1.2f * amp;
      fe_anim_insert_keyframe(object_slot, FE_CH_ROT_Z, start_frame, base[FE_CH_ROT_Z] - deg, FE_INTERP_BEZIER_SMOOTH);
      fe_anim_insert_keyframe(object_slot, FE_CH_ROT_Z, mid,         base[FE_CH_ROT_Z] + deg, FE_INTERP_BEZIER_SMOOTH);
      fe_anim_insert_keyframe(object_slot, FE_CH_ROT_Z, end_frame,   base[FE_CH_ROT_Z] - deg, FE_INTERP_BEZIER_SMOOTH);

      fe_anim_insert_keyframe(object_slot, FE_CH_POS_X, start_frame, base[FE_CH_POS_X] - swing_x, FE_INTERP_BEZIER_SMOOTH);
      fe_anim_insert_keyframe(object_slot, FE_CH_POS_X, mid,         base[FE_CH_POS_X] + swing_x, FE_INTERP_BEZIER_SMOOTH);
      fe_anim_insert_keyframe(object_slot, FE_CH_POS_X, end_frame,   base[FE_CH_POS_X] - swing_x, FE_INTERP_BEZIER_SMOOTH);
      break;
    }
    case FE_PRESET_CAMERA_ORBIT: {
      fe_anim_set_extrapolation(object_slot, FE_EXTRAP_LOOP);
      const float rad = fe::maxf(2.5f, fe::sqrtf(base[FE_CH_POS_X] * base[FE_CH_POS_X] + base[FE_CH_POS_Z] * base[FE_CH_POS_Z])) * amp;
      const float base_angle = fe::atan2f(base[FE_CH_POS_Z], base[FE_CH_POS_X]);
      const uint32_t steps = 8;
      for (uint32_t i = 0; i <= steps; ++i) {
        const float t = static_cast<float>(i) / static_cast<float>(steps);
        const float f = start_frame + span * t;
        const float ang = base_angle + t * fe::kTwoPi;
        fe_anim_insert_keyframe(object_slot, FE_CH_POS_X, f, fe::cosf(ang) * rad, FE_INTERP_BEZIER_SMOOTH);
        fe_anim_insert_keyframe(object_slot, FE_CH_POS_Z, f, fe::sinf(ang) * rad, FE_INTERP_BEZIER_SMOOTH);
        fe_anim_insert_keyframe(object_slot, FE_CH_POS_Y, f, base[FE_CH_POS_Y] + fe::sinf(t * fe::kTwoPi) * 0.6f, FE_INTERP_BEZIER_SMOOTH);
      }
      break;
    }
    case FE_PRESET_PULSE_SCALE:
    default: {
      fe_anim_set_extrapolation(object_slot, FE_EXTRAP_LOOP);
      const float factor = 1.0f + 0.28f * amp;
      for (uint32_t c = FE_CH_SCL_X; c <= FE_CH_SCL_Z; ++c) {
        fe_anim_insert_keyframe(object_slot, c, start_frame, base[c], FE_INTERP_BEZIER_SMOOTH);
        fe_anim_insert_keyframe(object_slot, c, mid,         base[c] * factor, FE_INTERP_BEZIER_SMOOTH);
        fe_anim_insert_keyframe(object_slot, c, end_frame,   base[c], FE_INTERP_BEZIER_SMOOTH);
      }
      break;
    }
  }
  return static_cast<int32_t>(fe_anim_get_keyframe_count(object_slot, 0xFFFFFFFFu));
}

/* Compact float serialization format:
 * [magic=43110.0f, version=1.0f, active_object_count]
 * Repeated per active object:
 *   [slot, extrapolation, rest[0..10], ch0_count, (frame,val,interp)..., ch10_count, ...]
 */
FE_EXPORT uint32_t fe_anim_serialized_float_count(void) {
  uint32_t count = 3;
  for (uint32_t s = 0; s < kMaxAnimatedObjects; ++s) {
    if (!g_tracks[s].initialized) continue;
    uint32_t keys = fe_anim_get_keyframe_count(s, 0xFFFFFFFFu);
    if (keys == 0) continue;
    count += 2 + FE_CH_COUNT + FE_CH_COUNT + keys * 3;
  }
  return count;
}

FE_EXPORT uint32_t fe_anim_serialize(float* out_floats, uint32_t max_floats) {
  const uint32_t needed = fe_anim_serialized_float_count();
  if (!out_floats || max_floats < needed) return 0;

  uint32_t active_objs = 0;
  for (uint32_t s = 0; s < kMaxAnimatedObjects; ++s) {
    if (g_tracks[s].initialized && fe_anim_get_keyframe_count(s, 0xFFFFFFFFu) > 0) {
      ++active_objs;
    }
  }

  uint32_t w = 0;
  out_floats[w++] = 43110.0f;
  out_floats[w++] = 1.0f;
  out_floats[w++] = static_cast<float>(active_objs);

  for (uint32_t s = 0; s < kMaxAnimatedObjects; ++s) {
    if (!g_tracks[s].initialized || fe_anim_get_keyframe_count(s, 0xFFFFFFFFu) == 0) continue;
    const ObjectAnimTrack& tr = g_tracks[s];
    out_floats[w++] = static_cast<float>(s);
    out_floats[w++] = static_cast<float>(tr.extrapolation);
    for (uint32_t c = 0; c < FE_CH_COUNT; ++c) out_floats[w++] = tr.rest[c];
    for (uint32_t c = 0; c < FE_CH_COUNT; ++c) {
      const ChannelTrack& ch = tr.channels[c];
      out_floats[w++] = static_cast<float>(ch.count);
      for (uint32_t k = 0; k < ch.count; ++k) {
        out_floats[w++] = ch.keys[k].frame;
        out_floats[w++] = ch.keys[k].value;
        out_floats[w++] = static_cast<float>(ch.keys[k].interp);
      }
    }
  }
  return w;
}

FE_EXPORT int32_t fe_anim_deserialize(const float* in_floats, uint32_t float_count) {
  if (!in_floats || float_count < 3) return -1;
  if (fe::absf(in_floats[0] - 43110.0f) > 0.5f || fe::absf(in_floats[1] - 1.0f) > 0.5f) return -2;

  fe_anim_reset();
  const uint32_t obj_count = static_cast<uint32_t>(in_floats[2]);
  uint32_t r = 3;

  for (uint32_t i = 0; i < obj_count; ++i) {
    if (r + 2 + FE_CH_COUNT > float_count) return -3;
    const uint32_t slot   = static_cast<uint32_t>(in_floats[r++]);
    const uint32_t extrap = static_cast<uint32_t>(in_floats[r++]);
    const float* rest_ptr = &in_floats[r];
    r += FE_CH_COUNT;

    if (slot < kMaxAnimatedObjects) {
      fe_anim_ensure_object(slot, rest_ptr);
      fe_anim_set_extrapolation(slot, extrap);
    }

    for (uint32_t c = 0; c < FE_CH_COUNT; ++c) {
      if (r >= float_count) return -4;
      const uint32_t kc = static_cast<uint32_t>(in_floats[r++]);
      if (r + kc * 3 > float_count) return -5;
      for (uint32_t k = 0; k < kc; ++k) {
        const float f = in_floats[r++];
        const float v = in_floats[r++];
        const uint32_t m = static_cast<uint32_t>(in_floats[r++]);
        if (slot < kMaxAnimatedObjects) {
          fe_anim_insert_keyframe(slot, c, f, v, m);
        }
      }
    }
  }
  return static_cast<int32_t>(fe_anim_get_total_keyframes());
}

} // extern "C"
