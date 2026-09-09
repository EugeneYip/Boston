/**
 * Where the game starts. One source of truth for the opening.
 *
 * Boston Common was the opening for the whole life of the project. It was chosen
 * because it reads instantly and because the player lands on a sidewalk spawn
 * point three metres from a car — nothing about it had to be authored. This
 * replaces it with the Northeastern arrival, which was authored: eighteen
 * survey-derived hero volumes, a quadrangle, PDDL sidewalk geometry and a
 * factual Huntington frontage all exist so that the first frame can be a real
 * place rather than a lawn.
 *
 * Every number here was measured, not chosen, and each one is load-bearing.
 *
 * ## The yaw is the trap
 *
 * `OPENING_YAW` is a CameraRig value, not a compass bearing. `CameraRig._apply`
 * builds forward as `(0,0,-1)` rotated about +Y, which is `(-sin yaw, -cos yaw)`.
 * A bearing measured the usual way, `atan2(dx, dz)`, is therefore **pi out**:
 *
 *     rig yaw = bearing - PI
 *
 * The composition was authored at bearing 65 degrees (1.134 rad), so the rig
 * value that produces it is 1.134 - PI = -2.007. Verified live: forward comes
 * out (0.906, 0.423), bearing 65.0 degrees. Write the bearing here in degrees
 * as well, so the next person can check the conversion instead of trusting it.
 *
 * ## The snap radius is not decoration
 *
 * `_pickSpawn` snaps to the nearest `sidewalk` spawn point. The retired opening
 * did that at ANY distance, which is safe when the anchor is already on a
 * sidewalk and catastrophic here: the nearest sidewalk point to the campus
 * anchor is on the Huntington footway, across the graded bank, and an unbounded
 * snap would silently move the player there and quietly undo this whole file.
 * `OPENING_SNAP_R` bounds it, so the snap can still tidy a few metres onto a
 * real walking surface but can never relocate the opening.
 *
 * ## The SUV anchor is a search target, not a transform
 *
 * `Vehicles.spawnStarter` already solves for a parking slot on the player's side
 * of the street, over road surface, clear of the parked-car props, preferring a
 * gap with room both sides, and takes the heading from the road tangent. Give it
 * the anchor and let it solve. Anchored here it lands about 2.8 m away at
 * (-1856.2, 1649.2) with tangent dot 1.000 — that difference is the solver
 * working, not drift. Do not paste a solved transform back into this file.
 */

/** Campus-side opening anchor, on Krentzman's south lawn. World metres. */
export const OPENING_PLAYER = { x: -1883, z: 1677 };

/** Compass bearing of the opening view, degrees. Documentation for the next line. */
export const OPENING_BEARING_DEG = 65;

/** CameraRig yaw that produces that bearing: `bearing - PI`. Radians. */
export const OPENING_YAW = -2.007;

/** Metres the spawn may snap to a sidewalk point. Bounded on purpose — see above. */
export const OPENING_SNAP_R = 6;

/** Search target for `spawnStarter`, on the Huntington kerbside. Not a transform. */
export const OPENING_SUV_ANCHOR = { x: -1858.6, z: 1650.6 };
