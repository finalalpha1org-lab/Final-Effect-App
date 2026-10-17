#![cfg_attr(not(test), no_std)]

#[cfg(not(test))]
use core::panic::PanicInfo;

#[cfg(not(test))]
#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    loop {}
}

const MAX_DEFORMABLE_NODES: usize = 32_768;
const MAX_FLUID_PARTICLES: usize = 4_096;
const MAX_CONSTRAINTS: usize = 131_072;
const MAX_STEP: f32 = 1.0 / 30.0;
const PI: f32 = 3.141_592_7;

type Bounds = [f32; 6];

#[inline]
fn clamp(value: f32, low: f32, high: f32) -> f32 {
    value.max(low).min(high)
}

#[inline]
fn safe_dt(dt: f32) -> f32 {
    if dt.is_finite() { clamp(dt, 0.0, MAX_STEP) } else { 0.0 }
}

#[inline]
fn sqrtf(value: f32) -> f32 {
    if value <= 0.0 { return 0.0; }
    let mut root = if value < 1.0 { 1.0 } else { value };
    for _ in 0..5 {
        root = 0.5 * (root + value / root);
    }
    root
}

#[inline]
fn collide_axis(position: &mut f32, velocity: &mut f32, low: f32, high: f32, restitution: f32, friction: f32) {
    if *position < low {
        *position = low;
        *velocity = (*velocity).abs() * restitution;
    } else if *position > high {
        *position = high;
        *velocity = -(*velocity).abs() * restitution;
    }
    *velocity *= 1.0 - friction;
}

#[inline]
fn collide_box(position: &mut [f32], velocity: &mut [f32], bounds: &Bounds, restitution: f32, friction: f32) {
    for axis in 0..3 {
        collide_axis(&mut position[axis], &mut velocity[axis], bounds[axis], bounds[axis + 3], restitution, friction);
    }
}

fn deformable_step_inner(
    positions: &mut [f32],
    previous: &mut [f32],
    rest: &[f32],
    pinned: &[u8],
    edges: &[u32],
    rest_lengths: &[f32],
    bounds: &Bounds,
    dt: f32,
    gravity: f32,
    damping: f32,
    stiffness: f32,
    goal_strength: f32,
    iterations: u32,
    restitution: f32,
    friction: f32,
) -> i32 {
    let nodes = positions.len() / 3;
    let edge_count = edges.len() / 2;
    if nodes == 0 || positions.len() % 3 != 0 || previous.len() != positions.len() || rest.len() != positions.len()
        || pinned.len() != nodes || rest_lengths.len() < edge_count || edges.len() % 2 != 0
        || nodes > MAX_DEFORMABLE_NODES || edge_count > MAX_CONSTRAINTS {
        return -1;
    }
    let dt = safe_dt(dt);
    if dt == 0.0 { return 0; }
    let damping = clamp(damping, 0.0, 0.99);
    let stiffness = clamp(stiffness, 0.0, 1.0);
    let goal = clamp(goal_strength, 0.0, 1.0);
    let bounce = clamp(restitution, 0.0, 1.0);
    let friction = clamp(friction, 0.0, 1.0);
    let iterations = iterations.clamp(1, 64) as usize;
    let dt2 = dt * dt;

    for node in 0..nodes {
        let i = node * 3;
        if pinned[node] != 0 {
            positions[i..i + 3].copy_from_slice(&rest[i..i + 3]);
            previous[i..i + 3].copy_from_slice(&rest[i..i + 3]);
            continue;
        }
        let old = [positions[i], positions[i + 1], positions[i + 2]];
        let velocity = [
            (old[0] - previous[i]) * (1.0 - damping),
            (old[1] - previous[i + 1]) * (1.0 - damping),
            (old[2] - previous[i + 2]) * (1.0 - damping),
        ];
        previous[i..i + 3].copy_from_slice(&old);
        positions[i] = old[0] + velocity[0];
        positions[i + 1] = old[1] + velocity[1] - gravity.max(0.0) * dt2;
        positions[i + 2] = old[2] + velocity[2];
        if goal > 0.0 {
            let correction = clamp(goal * dt * 8.0, 0.0, 0.5);
            for axis in 0..3 {
                positions[i + axis] += (rest[i + axis] - positions[i + axis]) * correction;
            }
        }
        let mut p = [positions[i], positions[i + 1], positions[i + 2]];
        let mut v = [positions[i] - old[0], positions[i + 1] - old[1], positions[i + 2] - old[2]];
        collide_box(&mut p, &mut v, bounds, bounce, friction);
        positions[i..i + 3].copy_from_slice(&p);
    }

    for _ in 0..iterations {
        for edge in 0..edge_count {
            let a = edges[edge * 2] as usize;
            let b = edges[edge * 2 + 1] as usize;
            if a >= nodes || b >= nodes || a == b { continue; }
            let ia = a * 3;
            let ib = b * 3;
            let dx = positions[ib] - positions[ia];
            let dy = positions[ib + 1] - positions[ia + 1];
            let dz = positions[ib + 2] - positions[ia + 2];
            let length = sqrtf(dx * dx + dy * dy + dz * dz);
            let target = rest_lengths[edge].max(1.0e-6);
            if length <= 1.0e-6 { continue; }
            let wa = if pinned[a] == 0 { 1.0 } else { 0.0 };
            let wb = if pinned[b] == 0 { 1.0 } else { 0.0 };
            let total = wa + wb;
            if total == 0.0 { continue; }
            let correction = ((length - target) / length) * stiffness;
            let scale_a = correction * wa / total;
            let scale_b = correction * wb / total;
            positions[ia] += dx * scale_a;
            positions[ia + 1] += dy * scale_a;
            positions[ia + 2] += dz * scale_a;
            positions[ib] -= dx * scale_b;
            positions[ib + 1] -= dy * scale_b;
            positions[ib + 2] -= dz * scale_b;
        }
        for node in 0..nodes {
            if pinned[node] != 0 { continue; }
            let i = node * 3;
            let mut p = [positions[i], positions[i + 1], positions[i + 2]];
            let mut v = [positions[i] - previous[i], positions[i + 1] - previous[i + 1], positions[i + 2] - previous[i + 2]];
            collide_box(&mut p, &mut v, bounds, bounce, friction);
            positions[i..i + 3].copy_from_slice(&p);
        }
    }
    1
}

fn sph_step_inner(
    positions: &mut [f32],
    velocities: &mut [f32],
    densities: &mut [f32],
    pressures: &mut [f32],
    forces: &mut [f32],
    bounds: &Bounds,
    dt: f32,
    particle_mass: f32,
    rest_density: f32,
    smoothing_length: f32,
    pressure_k: f32,
    viscosity: f32,
    gravity: [f32; 3],
    restitution: f32,
    damping: f32,
) -> i32 {
    let count = positions.len() / 3;
    if count == 0 || positions.len() % 3 != 0 || velocities.len() != positions.len()
        || densities.len() < count || pressures.len() < count || forces.len() < positions.len() || count > MAX_FLUID_PARTICLES {
        return -1;
    }
    let dt = safe_dt(dt);
    if dt == 0.0 { return 0; }
    let h = smoothing_length.max(1.0e-3);
    let h2 = h * h;
    let h3 = h2 * h;
    let h6 = h3 * h3;
    let h9 = h6 * h3;
    let poly6 = 315.0 / (64.0 * PI * h9.max(1.0e-12));
    let spiky = -45.0 / (PI * h6.max(1.0e-12));
    let viscosity_lap = 45.0 / (PI * h6.max(1.0e-12));
    let mass = particle_mass.max(1.0e-5);
    let rho0 = rest_density.max(1.0e-5);

    for i in 0..count {
        let pi = i * 3;
        let mut rho = 0.0;
        for j in 0..count {
            let pj = j * 3;
            let dx = positions[pi] - positions[pj];
            let dy = positions[pi + 1] - positions[pj + 1];
            let dz = positions[pi + 2] - positions[pj + 2];
            let r2 = dx * dx + dy * dy + dz * dz;
            if r2 < h2 {
                let q = h2 - r2;
                rho += mass * poly6 * q * q * q;
            }
        }
        densities[i] = rho.max(1.0e-5);
        pressures[i] = pressure_k.max(0.0) * (densities[i] - rho0);
    }

    let restitution = clamp(restitution, 0.0, 1.0);
    let damping = clamp(damping, 0.0, 1.0);
    for i in 0..count {
        let pi = i * 3;
        let mut force = [0.0; 3];
        for j in 0..count {
            if i == j { continue; }
            let pj = j * 3;
            let delta = [positions[pi] - positions[pj], positions[pi + 1] - positions[pj + 1], positions[pi + 2] - positions[pj + 2]];
            let r2 = delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2];
            if r2 <= 1.0e-10 || r2 >= h2 { continue; }
            let r = sqrtf(r2);
            let density_j = densities[j].max(1.0e-5);
            let pressure_gradient = spiky * (h - r) * (h - r) / r;
            let pressure_scale = -mass * (pressures[i] + pressures[j]) / (2.0 * density_j) * pressure_gradient;
            let visc_scale = viscosity.max(0.0) * mass * viscosity_lap * (h - r) / density_j;
            for axis in 0..3 {
                force[axis] += delta[axis] * pressure_scale + (velocities[pj + axis] - velocities[pi + axis]) * visc_scale;
            }
        }
        let rho = densities[i].max(1.0e-5);
        for axis in 0..3 { forces[pi + axis] = force[axis] / rho + gravity[axis]; }
    }
    for i in 0..count {
        let pi = i * 3;
        for axis in 0..3 {
            velocities[pi + axis] = (velocities[pi + axis] + forces[pi + axis] * dt) * (1.0 - damping * dt);
            positions[pi + axis] += velocities[pi + axis] * dt;
        }
        let mut p = [positions[pi], positions[pi + 1], positions[pi + 2]];
        let mut v = [velocities[pi], velocities[pi + 1], velocities[pi + 2]];
        collide_box(&mut p, &mut v, bounds, restitution, 0.0);
        positions[pi..pi + 3].copy_from_slice(&p);
        velocities[pi..pi + 3].copy_from_slice(&v);
    }
    1
}

fn buoyant_tracer_step_inner(
    positions: &mut [f32],
    velocities: &mut [f32],
    temperatures: &mut [f32],
    ages: &mut [f32],
    bounds: &Bounds,
    dt: f32,
    gravity: f32,
    buoyancy: f32,
    drag: f32,
    heat_decay: f32,
    max_age: f32,
    restitution: f32,
) -> i32 {
    let count = positions.len() / 3;
    if count == 0 || positions.len() % 3 != 0 || velocities.len() != positions.len()
        || temperatures.len() < count || ages.len() < count || count > MAX_FLUID_PARTICLES {
        return -1;
    }
    let dt = safe_dt(dt);
    if dt == 0.0 { return 0; }
    let drag_factor = 1.0 / (1.0 + drag.max(0.0) * dt);
    for i in 0..count {
        if ages[i] >= max_age.max(0.0) {
            temperatures[i] = 0.0;
            velocities[i * 3..i * 3 + 3].fill(0.0);
            continue;
        }
        let base = i * 3;
        let lift = buoyancy * temperatures[i].max(0.0) - gravity;
        velocities[base + 1] = (velocities[base + 1] + lift * dt) * drag_factor;
        velocities[base] *= drag_factor;
        velocities[base + 2] *= drag_factor;
        for axis in 0..3 {
            positions[base + axis] += velocities[base + axis] * dt;
        }
        let mut p = [positions[base], positions[base + 1], positions[base + 2]];
        let mut v = [velocities[base], velocities[base + 1], velocities[base + 2]];
        collide_box(&mut p, &mut v, bounds, clamp(restitution, 0.0, 1.0), 0.02);
        positions[base..base + 3].copy_from_slice(&p);
        velocities[base..base + 3].copy_from_slice(&v);
        temperatures[i] = (temperatures[i] * (1.0 - heat_decay.max(0.0) * dt)).max(0.0);
        ages[i] += dt;
    }
    1
}

unsafe fn f32_mut<'a>(ptr: u32, len: usize) -> Option<&'a mut [f32]> {
    if ptr == 0 || len == 0 { return None; }
    Some(core::slice::from_raw_parts_mut(ptr as *mut f32, len))
}

unsafe fn f32_ref<'a>(ptr: u32, len: usize) -> Option<&'a [f32]> {
    if ptr == 0 || len == 0 { return None; }
    Some(core::slice::from_raw_parts(ptr as *const f32, len))
}

unsafe fn u32_ref<'a>(ptr: u32, len: usize) -> Option<&'a [u32]> {
    if ptr == 0 || len == 0 { return None; }
    Some(core::slice::from_raw_parts(ptr as *const u32, len))
}

unsafe fn u8_ref<'a>(ptr: u32, len: usize) -> Option<&'a [u8]> {
    if ptr == 0 || len == 0 { return None; }
    Some(core::slice::from_raw_parts(ptr as *const u8, len))
}

#[no_mangle]
pub extern "C" fn sim_solver_abi_version() -> u32 { 1 }

#[no_mangle]
pub extern "C" fn sim_solver_deformable_step(
    positions_ptr: u32, previous_ptr: u32, rest_ptr: u32, pinned_ptr: u32,
    edges_ptr: u32, rest_lengths_ptr: u32, node_count: u32, edge_count: u32,
    dt: f32, gravity: f32, damping: f32, stiffness: f32, goal_strength: f32,
    iterations: u32, bounds_ptr: u32, restitution: f32, friction: f32,
) -> i32 {
    let nodes = node_count as usize;
    let edge_count = edge_count as usize;
    if nodes == 0 || nodes > MAX_DEFORMABLE_NODES || edge_count > MAX_CONSTRAINTS { return -2; }
    unsafe {
        let (Some(pos), Some(prev), Some(rest), Some(pins), Some(edges), Some(lengths), Some(b)) = (
            f32_mut(positions_ptr, nodes * 3), f32_mut(previous_ptr, nodes * 3), f32_ref(rest_ptr, nodes * 3),
            u8_ref(pinned_ptr, nodes), u32_ref(edges_ptr, edge_count * 2), f32_ref(rest_lengths_ptr, edge_count),
            f32_ref(bounds_ptr, 6),
        ) else { return -3; };
        let bounds: Bounds = [b[0], b[1], b[2], b[3], b[4], b[5]];
        deformable_step_inner(pos, prev, rest, pins, edges, lengths, &bounds, dt, gravity, damping, stiffness, goal_strength, iterations, restitution, friction)
    }
}

#[no_mangle]
pub extern "C" fn sim_solver_sph_step(
    positions_ptr: u32, velocities_ptr: u32, densities_ptr: u32, pressures_ptr: u32, forces_ptr: u32,
    particle_count: u32, dt: f32, mass: f32, rest_density: f32, smoothing_length: f32,
    pressure_k: f32, viscosity: f32, gravity_x: f32, gravity_y: f32, gravity_z: f32,
    bounds_ptr: u32, restitution: f32, damping: f32,
) -> i32 {
    let count = particle_count as usize;
    if count == 0 || count > MAX_FLUID_PARTICLES { return -2; }
    unsafe {
        let (Some(pos), Some(vel), Some(rho), Some(pressure), Some(forces), Some(b)) = (
            f32_mut(positions_ptr, count * 3), f32_mut(velocities_ptr, count * 3),
            f32_mut(densities_ptr, count), f32_mut(pressures_ptr, count), f32_mut(forces_ptr, count * 3), f32_ref(bounds_ptr, 6),
        ) else { return -3; };
        let bounds: Bounds = [b[0], b[1], b[2], b[3], b[4], b[5]];
        sph_step_inner(pos, vel, rho, pressure, forces, &bounds, dt, mass, rest_density, smoothing_length, pressure_k, viscosity, [gravity_x, gravity_y, gravity_z], restitution, damping)
    }
}

#[no_mangle]
pub extern "C" fn sim_solver_buoyant_tracer_step(
    positions_ptr: u32, velocities_ptr: u32, temperatures_ptr: u32, ages_ptr: u32,
    particle_count: u32, dt: f32, gravity: f32, buoyancy: f32, drag: f32,
    heat_decay: f32, max_age: f32, bounds_ptr: u32, restitution: f32,
) -> i32 {
    let count = particle_count as usize;
    if count == 0 || count > MAX_FLUID_PARTICLES { return -2; }
    unsafe {
        let (Some(pos), Some(vel), Some(temp), Some(age), Some(b)) = (
            f32_mut(positions_ptr, count * 3), f32_mut(velocities_ptr, count * 3),
            f32_mut(temperatures_ptr, count), f32_mut(ages_ptr, count), f32_ref(bounds_ptr, 6),
        ) else { return -3; };
        let bounds: Bounds = [b[0], b[1], b[2], b[3], b[4], b[5]];
        buoyant_tracer_step_inner(pos, vel, temp, age, &bounds, dt, gravity, buoyancy, drag, heat_decay, max_age, restitution)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deformable_constraints_preserve_edge_length_and_gravity_moves_nodes() {
        let bounds = [-10.0, -10.0, -10.0, 10.0, 10.0, 10.0];
        let mut pos = [0.0, 0.0, 0.0, 1.3, 0.0, 0.0];
        let mut prev = pos;
        let rest = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        let pins = [1, 0];
        let edges = [0, 1];
        let lengths = [1.0];
        let rc = deformable_step_inner(&mut pos, &mut prev, &rest, &pins, &edges, &lengths, &bounds, 1.0 / 60.0, 9.8, 0.0, 1.0, 0.0, 12, 0.0, 0.0);
        assert_eq!(rc, 1);
        assert_eq!(&pos[0..3], &rest[0..3]);
        let edge = sqrtf((pos[3] - pos[0]).powi(2) + (pos[4] - pos[1]).powi(2) + (pos[5] - pos[2]).powi(2));
        assert!((edge - 1.0).abs() < 1.0e-3);
        assert!(pos[4] < 0.0);
    }

    #[test]
    fn sph_fluid_produces_finite_density_and_respects_box_collision() {
        let bounds = [-1.0, -1.0, -1.0, 1.0, 1.0, 1.0];
        let mut pos = [0.0, 0.0, 0.0, 0.2, 0.0, 0.0];
        let mut vel = [0.0; 6];
        let mut rho = [0.0; 2];
        let mut pressure = [0.0; 2];
        let mut forces = [0.0; 6];
        let rc = sph_step_inner(&mut pos, &mut vel, &mut rho, &mut pressure, &mut forces, &bounds, 1.0 / 60.0, 1.0, 1.0, 0.5, 8.0, 0.1, [0.0, -9.8, 0.0], 0.1, 0.001);
        assert_eq!(rc, 1);
        assert!(rho.iter().all(|value| value.is_finite() && *value > 0.0));
        assert!(pos.iter().all(|value| value.is_finite()));
        assert!(pos[1] >= -1.0 && pos[4] >= -1.0);
    }

    #[test]
    fn hot_tracers_rise_and_cool() {
        let bounds = [-10.0, -10.0, -10.0, 10.0, 10.0, 10.0];
        let mut pos = [0.0, 0.0, 0.0];
        let mut vel = [0.0, 0.0, 0.0];
        let mut temp = [1.0];
        let mut age = [0.0];
        let rc = buoyant_tracer_step_inner(&mut pos, &mut vel, &mut temp, &mut age, &bounds, 0.1, 9.8, 20.0, 0.1, 0.2, 10.0, 0.0);
        assert_eq!(rc, 1);
        assert!(pos[1] > 0.0);
        assert!(temp[0] < 1.0 && age[0] > 0.0);
    }
}
