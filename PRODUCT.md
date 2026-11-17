# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

Trompe textures existing game-level geometry from generated camera views. The comparison tool evaluates Trompe and multiview-to-real on one shared Tatooine-inspired scene.

## Operating Context

Existing TypeScript / Three.js / Vite application, local GPU rendering, cloud image generation through fal. The first comparison uses six cameras and a user-confirmed total generation budget of $5. The comparison is a local engineering tool in this repository.

## Capabilities and Constraints

Keep geometry and camera calibration identical in controlled comparisons. Show measured coverage, error and missing evidence separately. Synthetic calibration images are not AI-generated results. Sequential and joint-grid targets are coupled; fusion holdout does not prove generation generalization. No API keys in source or reports.

## Evidence on Hand

Existing recorded experiments are documented in README.md. New benchmark results must be produced by the runner, never fabricated or promoted from smoke tests.

## Product Principles

- Compare the same inputs before attributing differences to algorithms.
- Make both outputs inspectable from the same camera.
- Preserve original artifacts and exact run settings.
- Report limitations alongside measurements.
